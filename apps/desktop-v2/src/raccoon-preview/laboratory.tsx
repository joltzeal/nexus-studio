import { useState } from "react";
import { Button, Switch, TabPanel, Tabs } from "@proxyshard/shardx-ui-kit";
import { SettingRow, SettingsGroup } from "../pages/settings/SettingRow";

type Browser = "cloakbrowser" | "aliasmode" | "shardbrowser" | "camoufox";
type Engine = "chromium" | "firefox";

export function LaboratorySection() {
  const [browser, setBrowser] = useState<Browser>("shardbrowser");
  const [engine, setEngine] = useState<Engine>("chromium");

  return (
    <div className="flex min-w-0 flex-col gap-3.5">
      <Tabs idBase="laboratory" aria-label="实验浏览器" value={browser} onChange={(value) => setBrowser(value as Browser)}
        items={[
          { value: "cloakbrowser", label: "CloakBrowser" },
          { value: "aliasmode", label: "AliasMode" },
          { value: "shardbrowser", label: "ShardBrowser" },
          { value: "camoufox", label: "Camoufox" },
        ]} />
      <TabPanel tabsId="laboratory" value={browser} className="flex flex-col gap-3.5">
        {browser === "aliasmode" && (
          <Tabs idBase="aliasmode-engine" aria-label="AliasMode 内核" value={engine}
            onChange={(value) => setEngine(value as Engine)}
            items={[{ value: "chromium", label: "Chromium" }, { value: "firefox", label: "Firefox" }]} />
        )}
        <SettingsGroup title={browser === "aliasmode" ? `AliasMode ${engine === "firefox" ? "Firefox" : "Chromium"}` : browser === "camoufox" ? "Camoufox" : browser === "shardbrowser" ? "ShardBrowser" : "CloakBrowser"}>
          <SettingRow id="lab-provider" title={`启用 ${browser === "shardbrowser" ? "ShardBrowser" : browser === "cloakbrowser" ? "CloakBrowser" : browser === "aliasmode" ? "AliasMode" : "Camoufox"}`}
            help={browser === "shardbrowser" ? "当前是网页样例预览。请在 Raccoon 桌面端的设置 → 实验室中启用 ShardBrowser，保存后下载内核。" : "此浏览器接入尚未开放。"}
            control={({ labelId, helpId }) => <Switch aria-labelledby={labelId} aria-describedby={helpId} checked={false} disabled />} />
          {browser === "cloakbrowser" && (
            <SettingRow id="lab-activation" title="激活码" help="需要桌面端校验服务。预览页不接收激活码。"
              control={() => <Button variant="neutral" mode="stroke" size="xsmall" disabled>填写激活码</Button>} />
          )}
          {browser !== "camoufox" && (
            <>
              <SettingRow id="lab-latest" title="检查内核更新"
                control={() => <Button variant="neutral" mode="stroke" size="xsmall" disabled>检查更新</Button>} />
              <SettingRow id="lab-download" title="本地内核"
                control={() => <Button variant="neutral" mode="stroke" size="xsmall" disabled>下载内核</Button>} />
            </>
          )}
        </SettingsGroup>
      </TabPanel>
    </div>
  );
}
