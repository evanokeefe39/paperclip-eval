import { Type } from "typebox";

export const PaginationSchema = Type.Optional(
  Type.Object({
    next_selector: Type.String({
      description: 'CSS selector for "next page" link',
    }),
    max_pages: Type.Number({
      description: "Maximum number of pages to crawl",
    }),
  })
);

export const ExtractFieldsSchema = Type.Optional(
  Type.Record(Type.String(), Type.String(), {
    description:
      'Map of field names to CSS selectors relative to each item (e.g. {"name": ".title", "price": ".cost"})',
  })
);
