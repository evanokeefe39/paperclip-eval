#!/usr/bin/env python3
"""Browser-rendered HTML fetcher using Scrapling's DynamicFetcher.

Returns raw HTML — extraction handled by the Node parse layer.
"""

import sys
import json
import time


def main():
    start = time.time()
    params = json.loads(sys.argv[1])
    url = params["url"]
    wait_for = params.get("wait_for", "")

    html = ""
    status_code = 0
    errors = []

    try:
        from scrapling import DynamicFetcher
        fetcher = DynamicFetcher()

        print(f"Fetching: {url}", file=sys.stderr)

        fetch_kwargs = {}
        if wait_for:
            fetch_kwargs["wait_selector"] = wait_for

        response = fetcher.fetch(url, **fetch_kwargs)
        status_code = response.status if hasattr(response, "status") else 200
        html = response.html_content if hasattr(response, "html_content") else str(response)

        if status_code >= 400:
            errors.append(f"HTTP {status_code}")

    except Exception as e:
        errors.append(str(e))
        print(f"Error: {e}", file=sys.stderr)

    duration_ms = int((time.time() - start) * 1000)

    result = {
        "html": html,
        "status_code": status_code,
        "url": url,
        "duration_ms": duration_ms,
        "errors": errors,
    }

    print(json.dumps(result))


if __name__ == "__main__":
    main()
