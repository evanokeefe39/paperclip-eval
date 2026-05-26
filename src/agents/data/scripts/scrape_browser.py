#!/usr/bin/env python3
"""Browser-rendered web scraper using Scrapling's DynamicFetcher (headless browser)."""

import sys
import json
import time
from urllib.parse import urljoin


def main():
    start = time.time()
    params = json.loads(sys.argv[1])

    url = params["url"]
    selector = params["selector"]
    extract_fields = params.get("extract_fields", {})
    pagination = params.get("pagination", {})
    max_items = params.get("max_items", 100)
    wait_for = params.get("wait_for", "")
    max_pages = pagination.get("max_pages", 1) if pagination else 1
    next_selector = pagination.get("next_selector", "") if pagination else ""

    items = []
    errors = []
    pages_crawled = 0
    current_url = url
    fetcher = None

    try:
        from scrapling import DynamicFetcher
        fetcher = DynamicFetcher()

        for page_num in range(max_pages):
            if not current_url:
                break

            try:
                print(f"Fetching page {page_num + 1}: {current_url}", file=sys.stderr)

                fetch_kwargs = {}
                if wait_for:
                    fetch_kwargs["wait_selector"] = wait_for

                response = fetcher.fetch(current_url, **fetch_kwargs)
                pages_crawled += 1

                elements = response.css(selector)

                for el in elements:
                    if len(items) >= max_items:
                        break

                    if extract_fields:
                        item = {}
                        for field_name, field_selector in extract_fields.items():
                            match = (el.css(field_selector) or [None])[0]
                            if match:
                                item[field_name] = str(match.text) or match.attrib.get("href", "") or match.attrib.get("src", "")
                            else:
                                item[field_name] = ""
                        items.append(item)
                    else:
                        text = str(el.text)
                        if text:
                            items.append({"text": text})

                if len(items) >= max_items:
                    break

                # Pagination
                if next_selector and page_num < max_pages - 1:
                    next_link = (response.css(next_selector) or [None])[0]
                    if next_link:
                        href = next_link.attrib.get("href", "")
                        if href:
                            current_url = urljoin(current_url, href)
                        else:
                            current_url = None
                    else:
                        current_url = None
                else:
                    current_url = None

            except Exception as e:
                errors.append(f"Page {page_num + 1} ({current_url}): {str(e)}")
                print(f"Error on page {page_num + 1}: {e}", file=sys.stderr)
                break

    except Exception as e:
        errors.append(f"Setup error: {str(e)}")
        print(f"Setup error: {e}", file=sys.stderr)

    duration_ms = int((time.time() - start) * 1000)

    result = {
        "items": items[:max_items],
        "pages_crawled": pages_crawled,
        "duration_ms": duration_ms,
        "errors": errors,
    }

    print(json.dumps(result))


if __name__ == "__main__":
    main()
