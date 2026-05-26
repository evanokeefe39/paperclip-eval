declare module "typebox" {
  export interface TSchema {
    [key: string]: any;
  }
  export interface TObject extends TSchema {}
  export interface TString extends TSchema {}
  export interface TNumber extends TSchema {}
  export interface TBoolean extends TSchema {}
  export interface TOptional<T extends TSchema = TSchema> extends TSchema {}
  export interface TRecord<
    K extends TSchema = TSchema,
    V extends TSchema = TSchema,
  > extends TSchema {}

  interface SchemaOptions {
    description?: string;
    default?: any;
    [key: string]: any;
  }

  export const Type: {
    Object(properties: Record<string, TSchema>, options?: SchemaOptions): TObject;
    String(options?: SchemaOptions): TString;
    Number(options?: SchemaOptions): TNumber;
    Boolean(options?: SchemaOptions): TBoolean;
    Optional(schema: TSchema): TOptional;
    Record(key: TSchema, value: TSchema, options?: SchemaOptions): TRecord;
    Array(items: TSchema, options?: SchemaOptions): TSchema;
    Union(schemas: TSchema[], options?: SchemaOptions): TSchema;
    Literal(value: string | number | boolean): TSchema;
    Unknown(options?: SchemaOptions): TSchema;
    Any(options?: SchemaOptions): TSchema;
    Null(options?: SchemaOptions): TSchema;
    Undefined(options?: SchemaOptions): TSchema;
    Enum(enumObj: Record<string, string | number>, options?: SchemaOptions): TSchema;
  };
}
