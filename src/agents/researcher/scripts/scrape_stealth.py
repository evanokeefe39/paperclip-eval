#!/usr/bin/env python3
"""Stealth HTML fetcher using Scrapling's anti-detection HTTP client.

Returns raw HTML — extraction handled by the Node parse layer.
"""

import sys
import json
import time


def main():
    start = time.time()
    params = json.loads(sys.argv[1])
    url = params["url"]

    html = ""
    status_code = 0
    errors = []

    try:
        from scrapling import Fetcher
        fetcher = Fetcher()

        print(f"Fetching: {url}", file=sys.stderr)
        response = fetcher.get(url)
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
