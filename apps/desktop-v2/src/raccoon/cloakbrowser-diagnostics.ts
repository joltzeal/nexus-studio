import { confirmModal } from "../shared/lib/confirm";
import { toast } from "../shared/model/toast";
import { cloakLicenseApi } from "./cloakbrowser-api";

let current: Promise<void> | undefined;

export function showCloakSessionDiagnostics(): Promise<void> {
  if (current) return current;
  toast.info("正在检查 CloakBrowser 授权席位");
  current = show().finally(() => { current = undefined; });
  return current;
}

async function show() {
  const api = cloakLicenseApi();
  const [remote, local] = await Promise.allSettled([api.seats(), api.localSessions()]);
  const seats = remote.status === "fulfilled" ? remote.value : null;
  const occupancy = seats?.active == null
    ? "官方席位状态未知。"
    : seats.limit === null
      ? `官方报告已占用 ${seats.active} 个席位。`
      : `官方席位已占用 ${seats.active} / ${seats.limit}。`;
  const sessions = local.status === "fulfilled" ? local.value : null;
  const localSummary = !sessions ? "无法读取本机会话。" : sessions.length === 0
    ? "本机未发现运行中或待核对的 CloakBrowser Profile。进程异常退出后，官方席位可能需要一段时间回收。"
    : "可在 CloakBrowser Workspace 的配置行停止运行中的 Profile 或结束已核实的残留会话。";
  const status = { running: "运行中", starting: "正在启动", stopping: "正在关闭", unknown: "状态待确认" };
  await confirmModal({
    title: "CloakBrowser 授权席位",
    message: `${occupancy} ${localSummary}`,
    items: sessions?.map((session) => ({ label: session.name, note: session.residual ? "已识别到残留会话" : status[session.state] })),
    buttons: [{ label: "完成", value: true, primary: true }],
  });
}
