import { seed, type MockFolders, type MockState, type MockTags, type StoredProfile } from "../dev/mock/fixtures";
import type { ProxyEntry, ProxyTestSnapshot } from "../entities/proxy/model/types";
import { useViews, type ProfileView } from "../entities/profile/lib/views";
import type { ProviderId } from "./sidebar";

type WorkspaceData = {
  profiles: Record<string, StoredProfile>;
  order: string[];
  folders: MockFolders;
  tags: MockTags;
  running: MockState["running"];
  views: ProfileView[];
  proxies: ProxyEntry[];
  snapshots: Record<string, ProxyTestSnapshot[]>;
};

const KEY = "raccoon-preview-workspaces";
const IDS: ProviderId[] = ["adspower", "bitbrowser", "shardbrowser", "cloakbrowser", "aliasmode"];
let current: ProviderId = "adspower";
let workspaces: Record<ProviderId, WorkspaceData>;
let applying = false;

type PreviewMock = { state: MockState; save: () => void };
const mock = () => (window as unknown as { __shardxMock: PreviewMock }).__shardxMock;
const blank = (): WorkspaceData => ({
  profiles: {}, order: [], folders: { registry: [], meta: {} },
  tags: { tags: [], by_profile: {} }, running: {},
  views: [], proxies: [], snapshots: {},
});

function initialWorkspaces(): Record<ProviderId, WorkspaceData> {
  const data = Object.fromEntries(IDS.map((id) => [id, blank()])) as Record<ProviderId, WorkspaceData>;
  const example = seed();
  const entries: { provider: ProviderId; folder: string; name: string }[] = [
    { provider: "adspower", folder: "Vinted US", name: "Vinted US · Studio 01" },
    { provider: "adspower", folder: "Vinted US", name: "Vinted US · Studio 02" },
    { provider: "adspower", folder: "Poshmark", name: "Poshmark · Archive" },
    { provider: "bitbrowser", folder: "Vinted", name: "Vinted · Account 01" },
    { provider: "shardbrowser", folder: "Daily work", name: "Daily listing" },
  ];
  for (const [index, entry] of entries.entries()) {
    const original = example.profiles[example.order[index]];
    if (!original) break;
    const id = crypto.randomUUID();
    const profile = structuredClone(original);
    profile.name = entry.name;
    profile.notes = "";
    profile._meta = {
      ...profile._meta, id, folder: entry.folder, proxy_id: null, pinned: false,
      last_launched_at: null, created_at: new Date(Date.now() - index * 86_400_000).toISOString(),
      total_runtime_ms: 0, launches: 0,
    };
    const workspace = data[entry.provider];
    workspace.profiles[id] = profile;
    workspace.order.push(id);
    if (!workspace.folders.registry.includes(entry.folder)) workspace.folders.registry.push(entry.folder);
  }
  return data;
}

function read(): Record<ProviderId, WorkspaceData> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (saved && typeof saved === "object" && IDS.every((id) => {
      const value = (saved as Record<string, WorkspaceData>)[id];
      return value && Array.isArray(value.order) && value.profiles && value.folders && Array.isArray(value.views);
    })) return saved as Record<ProviderId, WorkspaceData>;
  } catch { /* An invalid preview snapshot starts fresh. */ }
  return initialWorkspaces();
}

function capture() {
  const state = mock().state;
  workspaces[current] = structuredClone({
    profiles: state.profiles, order: state.order,
    folders: state.folders ?? { registry: [], meta: {} },
    tags: state.tags ?? { tags: [], by_profile: {} }, running: state.running,
    views: useViews.getState().views,
    proxies: state.proxies, snapshots: state.snapshots,
  });
  try { localStorage.setItem(KEY, JSON.stringify(workspaces)); } catch { /* Preview data may be ephemeral. */ }
}

function apply(id: ProviderId) {
  applying = true;
  try {
    const state = mock().state;
    const data = workspaces[id];
    state.profiles = structuredClone(data.profiles);
    state.order = [...data.order];
    state.folders = structuredClone(data.folders);
    state.tags = structuredClone(data.tags);
    state.running = structuredClone(data.running);
    useViews.setState({ views: structuredClone(data.views) });
    state.trash = [];
    mock().save();
  } finally {
    applying = false;
  }
}

export function initializePreviewWorkspaces() {
  workspaces = read();
  const state = mock().state;
  state.proxies = [];
  state.snapshots = {};
  state.extensions = [];
  state.bookmarks = [];
  state.space = { kind: "personal" };
  state.dataOf = "personal";
  state.teams = [];
  state.teamServers = {};
  apply(current);
  window.addEventListener("pagehide", capture);
}

export function switchPreviewWorkspace(id: ProviderId) {
  if (id === current) return;
  capture();
  current = id;
  apply(id);
}

export function savePreviewWorkspace() { if (!applying) capture(); }

export function previewRunning() {
  return Object.fromEntries(Object.entries(mock().state.running)
    .map(([id, value]) => [id, value.started]));
}
