import { isNativeRaccoon } from "../runtime.ts";
import { NativeAutomationClient } from "./client.ts";

let transport: (command: string, args?: Record<string, unknown>) => Promise<unknown> =
  async () => { throw new Error("自动化原生服务尚未初始化"); };

export const automationClient = new NativeAutomationClient({ call: (command, args) => transport(command, args) });
export function configureAutomationTransport(call: typeof transport) { transport = call; }
export const setAutomationConnection = (connectionId: string | null) => automationClient.select(connectionId);
export const automationConnection = automationClient.connection;
export const automationScope = automationClient.scope;
export const isAutomationScopeCurrent = automationClient.isCurrent;
export function isAutomationEventCurrent(payload: { connection_id?: string }): boolean {
  return !isNativeRaccoon() || !!automationConnection() && payload.connection_id === automationConnection();
}
