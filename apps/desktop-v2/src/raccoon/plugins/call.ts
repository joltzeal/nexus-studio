import { invoke } from "@tauri-apps/api/core";

export class PluginCallError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.name = "PluginCallError";
    this.code = code;
    this.retryable = retryable;
  }
}

export async function callPlugin<T>(
  id: string,
  capability: string,
  method: string,
  payload: unknown,
  parse: (value: unknown) => T,
  deadlineMs = 30_000,
  expectedIdentity?: string,
): Promise<T> {
  let result: unknown;
  try {
    result = await invoke<unknown>("plugin_call", {
      input: { id, capability, method, payload, deadlineMs,
        ...(expectedIdentity === undefined ? {} : { expectedIdentity }),
      },
    });
  } catch (cause) {
    if (cause && typeof cause === "object" && !Array.isArray(cause)) {
      const error = cause as Record<string, unknown>;
      if (typeof error.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
        && typeof error.message === "string" && error.message.length <= 4096
        && typeof error.retryable === "boolean") {
        throw new PluginCallError(error.code, error.message, error.retryable);
      }
    }
    throw new Error("插件调用失败，请重试");
  }
  return parse(result);
}
