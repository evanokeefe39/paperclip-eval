#!/usr/bin/env bash
set -euo pipefail

# Prevent MSYS/Git Bash from mangling /unix/paths in docker exec args
export MSYS_NO_PATHCONV=1

if command -v cygpath >/dev/null 2>&1; then
  SCRIPT_DIR="$(cygpath -w "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)")"
  REPO_ROOT="$(cygpath -w "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)")"
else
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
fi

PAPERCLIP_URL="${PAPERCLIP_URL:-http://127.0.0.1:3100}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@eval.local}"
ADMIN_PASS="${ADMIN_PASS:-eval-admin-2026}"
COMPANY_NAME="${COMPANY_NAME:-eval}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"
SKIP_BUILD="${SKIP_BUILD:-}"

for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=1 ;;
  esac
done

COOKIE_JAR="$(mktemp)"
trap 'rm -f "$COOKIE_JAR"' EXIT

log() {
  local color="$1"; shift
  case "$color" in
    green)  printf '\033[32m%s\033[0m\n' "$*" ;;
    red)    printf '\033[31m%s\033[0m\n' "$*" ;;
    cyan)   printf '\033[36m%s\033[0m\n' "$*" ;;
    *)      printf '%s\n' "$*" ;;
  esac
}

check_deps() {
  local missing=()
  for cmd in curl jq docker; do
    command -v "$cmd" >/dev/null 2>&1 || missing+=("$cmd")
  done
  if [[ ${#missing[@]} -gt 0 ]]; then
    log red "Missing required tools: ${missing[*]}"
    exit 1
  fi
}

api_post() {
  local path="$1" body="$2"
  local url="${PAPERCLIP_URL}${path}"
  local http_code response
  response="$(curl -s -w '\n%{http_code}' -X POST "$url" \
    -H 'Content-Type: application/json' \
    -H "Origin: ${PAPERCLIP_URL}" \
    -b "$COOKIE_JAR" -c "$COOKIE_JAR" \
    -d "$body")"
  http_code="$(echo "$response" | tail -1)"
  local resp_body
  resp_body="$(echo "$response" | sed '$d')"
  if [[ "$http_code" -lt 200 || "$http_code" -ge 300 ]]; then
    log red "POST $path failed (HTTP $http_code)"
    log red "$resp_body"
    return 1
  fi
  echo "$resp_body"
}

api_patch() {
  local path="$1" body="$2"
  local url="${PAPERCLIP_URL}${path}"
  local http_code response
  response="$(curl -s -w '\n%{http_code}' -X PATCH "$url" \
    -H 'Content-Type: application/json' \
    -H "Origin: ${PAPERCLIP_URL}" \
    -b "$COOKIE_JAR" -c "$COOKIE_JAR" \
    -d "$body")"
  http_code="$(echo "$response" | tail -1)"
  local resp_body
  resp_body="$(echo "$response" | sed '$d')"
  if [[ "$http_code" -lt 200 || "$http_code" -ge 300 ]]; then
    log red "PATCH $path failed (HTTP $http_code)"
    log red "$resp_body"
    return 1
  fi
  echo "$resp_body"
}

api_get() {
  local path="$1"
  local url="${PAPERCLIP_URL}${path}"
  local http_code response
  response="$(curl -s -w '\n%{http_code}' "$url" \
    -H "Origin: ${PAPERCLIP_URL}" \
    -b "$COOKIE_JAR" -c "$COOKIE_JAR")"
  http_code="$(echo "$response" | tail -1)"
  local resp_body
  resp_body="$(echo "$response" | sed '$d')"
  if [[ "$http_code" -lt 200 || "$http_code" -ge 300 ]]; then
    log red "GET $path failed (HTTP $http_code)"
    log red "$resp_body"
    return 1
  fi
  echo "$resp_body"
}

wait_healthy() {
  local timeout="${1:-90}"
  local deadline=$((SECONDS + timeout))
  log cyan "Waiting for Paperclip..."
  while [[ $SECONDS -lt $deadline ]]; do
    if dc exec -T paperclip node -e \
      "fetch('http://localhost:3100/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))" \
      >/dev/null 2>&1; then
      log green "Paperclip healthy."
      return 0
    fi
    sleep 2
  done
  log red "Paperclip not healthy after ${timeout}s"
  dc logs paperclip --tail 20
  return 1
}

authenticate() {
  log cyan "Authenticating..."
  local signup
  signup="$(jq -n --arg n "Eval Admin" --arg e "$ADMIN_EMAIL" --arg p "$ADMIN_PASS" \
    '{name:$n, email:$e, password:$p}')"
  if api_post "/api/auth/sign-up/email" "$signup" >/dev/null 2>&1; then
    log green "  Signed up."
    return 0
  fi
  local signin
  signin="$(jq -n --arg e "$ADMIN_EMAIL" --arg p "$ADMIN_PASS" \
    '{email:$e, password:$p}')"
  api_post "/api/auth/sign-in/email" "$signin" >/dev/null
  log green "  Signed in."
}

bootstrap() {
  log cyan "Creating bootstrap invite..."

  cat "${SCRIPT_DIR}/paperclip-config.json" | dc exec -T paperclip sh -c 'cat > /paperclip/instances/default/config.json && chown node:node /paperclip/instances/default/config.json' 2>/dev/null || true
  cat "${SCRIPT_DIR}/bootstrap-invite.cjs" | dc exec -T paperclip sh -c 'cat > /tmp/bootstrap-invite.cjs'

  local output
  output="$(dc exec -T paperclip node /tmp/bootstrap-invite.cjs 2>&1)"

  if echo "$output" | grep -qi "already exists"; then
    log green "  Bootstrap already done, skipping."
    return 0
  fi

  if ! echo "$output" | grep -q '/invite/'; then
    log red "Bootstrap failed: $output"
    return 1
  fi

  local token
  token="$(echo "$output" | grep '/invite/' | sed 's|.*/invite/||' | tr -d '[:space:]')"
  log green "  Token: $token"

  api_post "/api/invites/${token}/accept" '{"requestType":"human"}' >/dev/null
  log green "  Admin bootstrapped."
}

create_company() {
  log cyan "Creating company..."
  local existing
  if existing="$(api_get "/api/companies" 2>/dev/null)"; then
    local found_id
    found_id="$(echo "$existing" | jq -r --arg name "$COMPANY_NAME" \
      '.[] | select(.name == $name) | .id // empty' 2>/dev/null | head -1)"
    if [[ -n "$found_id" ]]; then
      COMPANY_ID="$found_id"
      COMPANY_EXISTING="true"
      log green "  Company: $COMPANY_ID (existing)"
      return 0
    fi
  fi

  local result
  result="$(api_post "/api/companies" "$(jq -n --arg n "$COMPANY_NAME" '{name:$n}')")"
  COMPANY_ID="$(echo "$result" | jq -r '.id')"
  log green "  Company: $COMPANY_ID"
}

create_agent_api_key() {
  local agent_id="$1" agent_name="$2"
  local key_name="${agent_name,,}-agent-key"
  local result
  result="$(api_post "/api/agents/${agent_id}/keys" \
    "$(jq -n --arg n "$key_name" '{name:$n}')")"
  echo "$result" | jq -r '.token'
}

write_agent_env() {
  local agent_dir="$1" agent_id="$2" api_key="$3"
  local env_file="${agent_dir}/.env"
  local existing_content=""

  if [[ -f "$env_file" ]]; then
    existing_content="$(grep -vE '^(PAPERCLIP_AGENT_ID|PAPERCLIP_API_KEY|PAPERCLIP_API_URL|PAPERCLIP_COMPANY_ID)=' "$env_file" 2>/dev/null || true)"
  fi

  {
    echo "PAPERCLIP_AGENT_ID=${agent_id}"
    echo "PAPERCLIP_API_KEY=${api_key}"
    echo "PAPERCLIP_API_URL=http://paperclip:3100"
    echo "PAPERCLIP_COMPANY_ID=${COMPANY_ID}"
    if [[ -n "$existing_content" ]]; then
      echo "$existing_content"
    fi
  } > "$env_file"

  log green "    Wrote ${env_file}"
}

register_agent() {
  local agent_dir="$1"
  local agent_json="${agent_dir}/agent.json"
  if [[ ! -f "$agent_json" ]]; then
    log red "No agent.json in $agent_dir"
    return 1
  fi

  local name
  name="$(jq -r '.name' "$agent_json")"

  local existing_agents agent_id=""
  if existing_agents="$(api_get "/api/companies/${COMPANY_ID}/agents" 2>/dev/null)"; then
    agent_id="$(echo "$existing_agents" | jq -r --arg n "$name" \
      '.[] | select(.name == $n) | .id // empty' 2>/dev/null | head -1)"
  fi

  if [[ -n "$agent_id" ]]; then
    REGISTERED_AGENTS["$name"]="$agent_id"
    EXISTING_FLAGS["$name"]="true"
    log green "  $name: $agent_id (existing)"

    local patch_payload
    patch_payload="$(jq '{runtimeConfig, adapterConfig, adapterType, role, title, icon, capabilities}
      | with_entries(select(.value != null))' "$agent_json")"
    if [[ "$patch_payload" != "{}" ]]; then
      if api_patch "/api/agents/${agent_id}" "$patch_payload" >/dev/null 2>&1; then
        log green "    Config synced from agent.json"
      else
        log red "    Failed to sync config (non-fatal)"
      fi
    fi
  else
    local payload
    payload="$(cat "$agent_json")"

    local reports_to
    reports_to="$(echo "$payload" | jq -r '.reportsTo // empty')"
    if [[ -n "$reports_to" ]]; then
      local manager_id="${REGISTERED_AGENTS[$reports_to]:-}"
      if [[ -z "$manager_id" ]]; then
        log red "  $name requires reportsTo=$reports_to but that agent is not registered"
        return 1
      fi
      payload="$(echo "$payload" | jq --arg id "$manager_id" '.reportsTo = $id')"
    fi

    local result
    result="$(api_post "/api/companies/${COMPANY_ID}/agent-hires" "$payload")"
    agent_id="$(echo "$result" | jq -r '.agent.id')"
    REGISTERED_AGENTS["$name"]="$agent_id"
    log green "  $name: $agent_id"
  fi

  local env_file="${agent_dir}/.env"
  if [[ "${EXISTING_FLAGS[$name]:-}" == "true" ]] && \
     [[ -f "$env_file" ]] && grep -q "^PAPERCLIP_API_KEY=pcp_" "$env_file" 2>/dev/null; then
    log green "    API key already in ${env_file}"
  else
    log cyan "    Creating API key for $name..."
    local api_key
    api_key="$(create_agent_api_key "$agent_id" "$name")"
    write_agent_env "$agent_dir" "$agent_id" "$api_key"
  fi
}

discover_agents() {
  log cyan "Registering agents..."
  local independent=() dependent=()

  for dir in "${SCRIPT_DIR}"/*/; do
    [[ -f "${dir}.pi/agent/config.yml" && -f "${dir}agent.json" ]] || continue
    local reports_to
    reports_to="$(jq -r '.reportsTo // empty' "${dir}agent.json")"
    if [[ -z "$reports_to" ]]; then
      independent+=("$dir")
    else
      dependent+=("$dir")
    fi
  done

  for dir in "${independent[@]}"; do
    register_agent "$dir"
  done
  for dir in "${dependent[@]}"; do
    register_agent "$dir"
  done
}

print_summary() {
  echo ""
  local all_existing=true
  for name in "${!REGISTERED_AGENTS[@]}"; do
    [[ -n "${EXISTING_FLAGS[$name]:-}" ]] || { all_existing=false; break; }
  done

  if [[ "$COMPANY_EXISTING" == "true" && "$all_existing" == "true" ]]; then
    log green "Already configured."
  else
    log green "Setup complete."
  fi

  local company_suffix=""
  [[ "$COMPANY_EXISTING" == "true" ]] && company_suffix=" (existing)"
  echo "  UI:         ${PAPERCLIP_URL}"
  echo "  Company:    ${COMPANY_ID}${company_suffix}"
  for name in "${!REGISTERED_AGENTS[@]}"; do
    local suffix=""
    [[ -n "${EXISTING_FLAGS[$name]:-}" ]] && suffix=" (existing)"
    printf '  %-12s%s%s\n' "${name}:" "${REGISTERED_AGENTS[$name]}" "$suffix"
  done
}

copy_auth_json() {
  local root_auth="${SCRIPT_DIR}/../../auth.json"
  if [[ ! -f "$root_auth" ]]; then
    log red "auth.json not found at repo root"
    return 1
  fi
  for dir in "${SCRIPT_DIR}"/*/; do
    [[ -f "${dir}.pi/agent/config.yml" ]] || continue
    local target="${dir}.pi/agent/auth.json"
    rm -f "$target"
    cp "$root_auth" "$target"
  done
  log green "auth.json distributed to agent dirs."
}

dc() {
  (cd "$REPO_ROOT" && docker compose -f "$COMPOSE_FILE" "$@")
}

fetch_skills() {
  log cyan "Fetching Paperclip skills from GitHub..."
  local skills_dir="${SCRIPT_DIR}/skills/paperclip-skills"
  local github_raw="https://raw.githubusercontent.com/paperclipai/paperclip/master/skills"

  local -a skill_files=(
    "paperclip/SKILL.md"
    "paperclip/references/api-reference.md"
    "paperclip/references/company-skills.md"
    "paperclip/references/issue-workspaces.md"
    "paperclip/references/routines.md"
    "paperclip/references/workflows.md"
    "paperclip-converting-plans-to-tasks/SKILL.md"
    "para-memory-files/SKILL.md"
    "para-memory-files/references/schemas.md"
  )

  local failed=0
  for file in "${skill_files[@]}"; do
    local dest="${skills_dir}/${file}"
    mkdir -p "$(dirname "$dest")"
    if curl -sf --max-time 15 -o "$dest" "${github_raw}/${file}"; then
      log green "  ${file}"
    else
      log red "  Failed: ${file}"
      ((failed++)) || true
    fi
  done

  if [[ $failed -gt 0 ]]; then
    log red "  ${failed} file(s) failed to fetch (agents will work without them)"
  else
    log green "  All skills fetched."
  fi
}

main() {
  check_deps

  declare -gA REGISTERED_AGENTS=()
  declare -gA EXISTING_FLAGS=()
  declare -g COMPANY_ID=""
  declare -g COMPANY_EXISTING="false"

  copy_auth_json
  fetch_skills

  log cyan "Starting services..."
  if [[ -n "$SKIP_BUILD" ]]; then
    dc up -d
  else
    dc up -d --build
  fi

  wait_healthy
  authenticate
  bootstrap
  create_company
  discover_agents
  print_summary
}

main "$@"
