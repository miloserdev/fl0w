/**
 * Minimal variant helper (the part of the `cva` API the UI components use), so the app does not need an extra dependency:
 * `variants({ size: "sm", className: "x" })` joins the base classes, the classes of every chosen variant value
 * (falling back to `defaultVariants`) and the extra `className`.
 */
type VariantMap = Record<string, Record<string, string>>;

type Choice<V extends VariantMap> = { [K in keyof V]?: keyof V[K] | null | undefined };

export function cva<V extends VariantMap>(base: string, config: { variants: V; defaultVariants?: Choice<V> }) {
  return (props: Choice<V> & { className?: string } = {}): string => {
    const classes = [base];
    for (const name of Object.keys(config.variants) as (keyof V & string)[]) {
      // null switches the variant off, undefined falls back to the default
      const picked = props[name] === undefined ? config.defaultVariants?.[name] : props[name];
      if (picked !== null && picked !== undefined) {
        const cls = config.variants[name]?.[picked as string];
        if (cls) classes.push(cls);
      }
    }
    if (props.className) classes.push(props.className);
    return classes.join(" ");
  };
}

/** Props accepted by a function made with `cva` (without `className`). */
export type VariantProps<T extends (props: never) => string> = Omit<NonNullable<Parameters<T>[0]>, "className">;
