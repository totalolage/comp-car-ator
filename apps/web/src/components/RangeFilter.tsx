/**
 * A range facet: two number fields, from and to, plus optional quick picks. Each keystroke
 * that makes a range narrows the table at once; the typed text is kept as typed ("1," while
 * writing 1,5, or a "from" above the "to") and is reset when the filter changes from
 * elsewhere (a quick pick) or the rail is cleared (the parent re-keys the component).
 * Shared by the catalog and model page rails.
 */
import type { Range } from "@cca/catalog";
import { useEffect, useRef, useState } from "preact/hooks";
import type { I18n } from "../i18n/i18n.ts";
import { rangeFromText } from "../lib/catalog-view.ts";

export default function RangeFilter(props: {
  /** Engine filter key, for `data-facet`. */
  facet: string;
  legend: string;
  value: Range | undefined;
  /** What the other filters leave, shown as placeholders. */
  bounds: { min: number; max: number } | null;
  disabled: boolean;
  t: I18n;
  /** Fraction digits the field accepts and shows (consumption: 1). */
  digits?: number;
  /** Years print bare (2020, not 2 020). */
  bare?: boolean;
  picks?: { label: string; range: Range }[];
  onChange(range: Range | undefined): void;
}) {
  const { facet, legend, value, bounds, disabled, t, digits = 0, bare, picks, onChange } = props;
  const [draft, setDraft] = useState({ min: text(value?.min), max: text(value?.max) });
  const typed = useRef(draft);
  typed.current = draft;
  useEffect(() => {
    const current = rangeFromText(typed.current.min, typed.current.max);
    if (current === null || current?.min !== value?.min || current?.max !== value?.max)
      setDraft({ min: text(value?.min), max: text(value?.max) });
  }, [value?.min, value?.max]);
  if (!bounds && !value) return null;

  const range = rangeFromText(draft.min, draft.max);
  const edit = (end: "min" | "max", input: string) => {
    const next = { ...draft, [end]: input };
    setDraft(next);
    const parsed = rangeFromText(next.min, next.max);
    if (parsed !== null) onChange(parsed); // else keep the text until it makes a range
  };
  const bound = (n: number | undefined) =>
    n === undefined ? "" : bare ? String(n) : t.number(digits ? n : Math.round(n), digits);

  return (
    <fieldset class="facet" data-facet={facet}>
      <legend>{legend}</legend>
      <div class="range">
        {(["min", "max"] as const).map((end) => (
          <input
            key={end}
            type="text"
            inputMode={digits ? "decimal" : "numeric"}
            autoComplete="off"
            aria-label={`${legend}: ${t.t(end === "min" ? "range.min" : "range.max")}`}
            placeholder={`${t.t(end === "min" ? "range.min" : "range.max")} ${bound(bounds?.[end])}`}
            value={draft[end]}
            aria-invalid={range === null}
            disabled={disabled}
            onInput={(e) => edit(end, (e.target as HTMLInputElement).value)}
          />
        ))}
      </div>
      {picks && (
        <div class="bands">
          {picks.map((pick) => {
            const pressed = value?.min === pick.range.min && value?.max === pick.range.max;
            return (
              <button
                key={pick.label}
                type="button"
                class="band"
                aria-pressed={pressed}
                disabled={disabled}
                onClick={() => onChange(pressed ? undefined : pick.range)}
              >
                {pick.label}
              </button>
            );
          })}
        </div>
      )}
    </fieldset>
  );
}

function text(n: number | undefined): string {
  return n === undefined ? "" : String(n);
}
