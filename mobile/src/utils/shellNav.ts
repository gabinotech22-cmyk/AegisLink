/**
 * shellNav — imperative navigation escape hatch for components that render
 * OUTSIDE Shell's custom stack navigator (App.tsx: `const [stack, setStack] =
 * useState<PushRoute[]>([])`, `push`/`pop`).
 *
 * `FloatingGroupCallBarRoot` is a sibling of `<Shell />` in `App()` (mounted
 * so the floating group-call bar can overlay ANY screen, including ones
 * outside Shell's own stack state) and therefore has no access to Shell's
 * `push` closure. Rather than lifting `stack`/`push` up to `App()` (a large,
 * invasive refactor of an already huge `Shell()`), Shell registers its `push`
 * capability here on mount and callers invoke it imperatively.
 *
 * This mirrors two module-level registration patterns already used in this
 * codebase for the same "call into Shell from outside its React tree"
 * problem:
 *   - `themedAlert()` / `AlertHost` (src/components/AlertHost.tsx)
 *   - `setNotificationOpenChatHandler()` (src/notifications/push.ts)
 *
 * Kept intentionally narrow (just the group-chat route) rather than
 * importing App.tsx's full `PushRoute` union — this module has a single
 * purpose (group-call banner -> group chat) and pulling in the whole
 * navigator type would add an avoidable coupling to App.tsx for one variant.
 */
import { useGroups } from '../store/groups';
import type { StoredGroup } from '../db/local';

export interface ShellNavGroupChatRoute {
  name: 'groupChat';
  group: StoredGroup;
}

export interface ShellNav {
  push: (route: ShellNavGroupChatRoute) => void;
}

let _shellNav: ShellNav | null = null;

/** Called by Shell() (App.tsx) on mount/unmount to (de)register its push(). */
export function registerShellNav(nav: ShellNav | null): void {
  _shellNav = nav;
}

/**
 * Resolves `groupId` to a `StoredGroup` via the groups store and pushes the
 * group-chat route onto Shell's nav stack. Returns `false` (no-op) when
 * Shell hasn't registered yet or the group can't be found — callers should
 * treat this as "nothing to navigate to" rather than throwing.
 */
export function navigateToGroupChat(groupId: string | null | undefined): boolean {
  if (!groupId || !_shellNav) return false;
  const group = useGroups.getState().groups.find((g) => g.id === groupId);
  if (!group) return false;
  _shellNav.push({ name: 'groupChat', group });
  return true;
}

/** Test-only reset — call in beforeEach/afterEach to avoid cross-test leakage. */
export function __resetShellNavForTests(): void {
  _shellNav = null;
}
