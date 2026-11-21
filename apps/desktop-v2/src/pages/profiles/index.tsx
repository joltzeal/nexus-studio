import { useEffect, useRef, type ComponentProps } from 'react'
import { activeTeam, useSpace } from '../../entities/space'
import {
  countActiveFilters,
  useCurrentView,
  useListTotal,
  useProfileUi,
  useVisibleProfiles,
  viewName,
} from '../../entities/profile'
import { loadSignalSources } from '../../entities/signals'
import { ViewBar } from '../../features/manage-views'
import { ProfileFilterChips } from '../../features/manage-profiles'
import { useSetupSteps } from '../../features/onboarding'
import { SetupChecklist } from '../../widgets/SetupChecklist'
import { Overview } from '../../widgets/Overview'
import { useProfile } from '../../entities/profile'
import { useT } from '../../shared/i18n'
import { PageBody, PageHeader } from '../../widgets/PageHeader'
import { ProfileBulkBar } from '../../widgets/ProfileBulkBar'
import { ProfileToolbar } from '../../widgets/ProfileTable/ProfileToolbar'
import { ProfileTable } from '../../widgets/ProfileTable/ProfileTable'
import { ProfileSidePanel } from '../../widgets/PluginPanel/ProfileSidePanel'
import { useHeldLoading } from '../../shared/hooks/useHeldLoading'
import { ListColumn } from '../../shared/ui/ListColumn'
import { ListStateCenter } from '../../shared/ui/ListStates'
import { PEEK_GAP, usePeekWidth } from '../../shared/ui/peek'
import { showMeAround } from '../../features/tour'
import { isNativeRaccoon } from '../../raccoon/runtime'
import { BitBrowserGuide, bitBrowserOffline } from '../../raccoon/BitBrowserGuide'
import { useWorkspace } from '../../raccoon/store'

// Profile data and process polling are loaded by the app shell (App.tsx):
// the sidebar needs them on every page.
export function ProfilesPage() {
  const t = useT()
  const search = useProfileUi((s) => s.search)
  const setSearch = useProfileUi((s) => s.setSearch)
  const folder = useProfileUi((s) => s.folder)
  const view = useCurrentView()
  const visible = useVisibleProfiles()
  const filters = useProfileUi((s) => s.filters)
  const total = useListTotal()
  // "3 of 8" while a search, a problem card's chip, or outside a View a
  // filter, narrows the list.
  const only = useProfileUi((s) => s.only !== null)
  const narrowed =
    search.trim() !== '' || only || (!view && countActiveFilters(filters) > 0)
  const hasProfiles = useProfile((s) => s.profiles.length > 0)
  const status = useProfile((s) => s.status)
  const state = useWorkspace()
  const connection = state.connections.find((row) => row.id === state.connectionId)
  const bitBrowserOfflineNow = bitBrowserOffline(connection, state.probe, state.loading)
  // No profiles at all: nothing to filter, count or arrange (LAYOUT-20).
  // Not while a search or filters narrow it: the empty state names them and
  // the header keeps the field and the menu that clear them, as Proxies.
  const setup = useSetupSteps()
  // The table's placeholder rows wait 150 ms and stay 400 ms (WIG-12). Held
  // here, above the table, so a fresh install's checklist waits for them too
  // (Pair 3 review, Minor 2): the table mounts with this page.
  const loading = useHeldLoading(status === 'idle' || status === 'loading')
  // Follows the held value, so the header controls and the placeholder rows
  // give way together, not up to 400 ms apart.
  const empty = !loading && status === 'ready' && !hasProfiles && !narrowed
  // Until the list is in, the table shows it loading (or why it failed).
  // Not a team's member's, nor a team's never read: its list is the team's to fill (ProfileListEmpty says so).
  const teamWaits = useSpace((s) => {
    const team = activeTeam(s.state)
    const st = s.state?.team_status
    return !!team && (!team.admin || (!!st && st.state !== 'ready' && !st.synced_at))
  })
  const showSetup = setup.active && status === 'ready' && !loading && !teamWaits
  // The problem cards read the proxies' last tests, the timezones those
  // judge and the ProxyShard plans: once per app session, when this page
  // first opens.
  useEffect(() => {
    loadSignalSources()
  }, [])
  // The list's row (its column and Peek): the overview sizes to it (below).
  const listRow = useRef<HTMLDivElement>(null)
  // Continue and Problems to fix belong to All profiles: inside a Folder or a
  // View the list is a narrower question, and the cards would be about
  // profiles it does not show (owner, 2026-10-07).
  const onAll = folder === 'all' && !view

  return (
    <>
      <PageHeader
        title={
          view ? viewName(view, t) : folder === 'all' ? t('profiles.allTitle') : folder
        }
        count={
          !loading && status === 'ready' && !empty
            ? narrowed
              ? { shown: visible.length, total }
              : visible.length
            : undefined
        }
        help={
          isNativeRaccoon()
            ? undefined
            : {
                title: t('pageHelp.profiles.title'),
                body: t('pageHelp.profiles.body'),
                onTour: () => showMeAround('profiles'),
              }
        }
        after={<ViewBar />}
        filter={empty ? undefined : { value: search, onChange: setSearch }}
        actions={<ProfileToolbar empty={empty} />}
      />
      <PageBody scroll={false} className="relative">
        {/* Peek always pushes the list: it never lies over it. */}
        {/* An empty list waits for the Trash to say whether this is a fresh
            install: no frame of "No profiles yet" before the checklist (PC-118).
            The placeholder rows keep their held time through it (WIG-12). */}
        {setup.deciding && !loading ? null : showSetup && !hasProfiles ? (
          // A fresh install: the checklist is the empty state.
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            <SetupChecklist />
          </div>
        ) : (
          <>
            {showSetup && (
              <div className="mb-3">
                <SetupChecklist compact />
              </div>
            )}
            <div
              ref={listRow}
              data-list-row
              className="relative flex min-h-0 flex-1 gap-panel"
            >
              {/* The list's own column: its bar and the toasts stay off Peek (F2). */}
              <ListColumn>
                {/* Continue and Problems to fix (the owner's redesign of the
                    Live layer's cards), on All profiles only, then the chips,
                    which belong to the list they narrow. Both in the list's
                    column, so Peek starts under the page header as every Peek
                    does (LAYOUT-12). Beside Peek they give it its room on
                    Peek's own path. */}
                {onAll && (
                  <PeekOverview
                    enabled={status === 'ready' && !loading && hasProfiles}
                    waiting={loading || status === 'idle' || status === 'loading'}
                    row={listRow}
                  />
                )}
                {/* The applied filters, each removable (O8); nothing while none applies. */}
                <ProfileFilterChips />
                {/* Before the list in Tab order; it floats over the list's bottom edge. */}
                <ProfileBulkBar />
                {bitBrowserOfflineNow ? (
                  <div className="list-tile flex min-h-0 flex-1">
                    <ListStateCenter>
                      <BitBrowserGuide />
                    </ListStateCenter>
                  </div>
                ) : (
                  <ProfileTable loading={loading} />
                )}
              </ListColumn>
              <ProfileSidePanel />
            </div>
          </>
        )}
      </PageBody>
    </>
  )
}

// Peek opening or closing reaches only what it moves: the overview (Peek takes
// its room). It reads Peek itself, so the page and everything else on it are
// not drawn again; that render ran between Peek's turn and its next frame, so
// the panel had moved on by then (craft item 6, peek-v2.spec.ts).

/** The overview; an open Peek beside the list takes its room. */
function PeekOverview(props: Omit<ComponentProps<typeof Overview>, 'peekSpace'>) {
  const width = usePeekWidth()
  const open = useProfileUi((s) => s.peekId !== null)
  return <Overview {...props} peekSpace={open ? width + PEEK_GAP : 0} />
}
