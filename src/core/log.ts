/** Minimal structured logger (JSON lines on stderr). Never pass secrets or payment payloads to it. */
type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const min = ORDER[(process.env.LOG_LEVEL as Level) ?? "info"] ?? ORDER.info;

function emit(level: Level, obj: Record<string, unknown> | string, msg?: string) {
  if (ORDER[level] < min) return;
  const fields = typeof obj === "string" ? { msg: obj } : { ...obj, msg };
  process.stderr.write(JSON.stringify({ level, time: new Date().toISOString(), ...fields }) + "\n");
}

export const log = {
  debug: (o: Record<string, unknown> | string, m?: string) => emit("debug", o, m),
  info: (o: Record<string, unknown> | string, m?: string) => emit("info", o, m),
  warn: (o: Record<string, unknown> | string, m?: string) => emit("warn", o, m),
  error: (o: Record<string, unknown> | string, m?: string) => emit("error", o, m),
};
