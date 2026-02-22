import { useEffect, useMemo, useRef } from 'react'
import { isTauri } from '../mock-tauri'
import { filterEntries, sortByModified, buildRelationshipGroups } from '../utils/noteListHelpers'
import type { VaultEntry, SidebarSelection } from '../types'

interface Tab {
  entry: VaultEntry
  content: string
}

interface KeyboardNavigationOptions {
  tabs: Tab[]
  activeTabPath: string | null
  entries: VaultEntry[]
  selection: SidebarSelection
  allContent: Record<string, string>
  onSwitchTab: (path: string) => void
  onReplaceActiveTab: (entry: VaultEntry) => void
  onSelectNote: (entry: VaultEntry) => void
}

function computeVisibleNotes(
  entries: VaultEntry[],
  selection: SidebarSelection,
  allContent: Record<string, string>,
): VaultEntry[] {
  if (selection.kind === 'entity') {
    return buildRelationshipGroups(selection.entry, entries, allContent)
      .flatMap((g) => g.entries)
  }
  return [...filterEntries(entries, selection)].sort(sortByModified)
}

function navigateTab(
  tabsRef: React.RefObject<Tab[]>,
  activeTabPathRef: React.RefObject<string | null>,
  onSwitchTab: React.RefObject<(path: string) => void>,
  direction: 1 | -1,
) {
  const currentTabs = tabsRef.current!
  if (currentTabs.length === 0) return

  const currentPath = activeTabPathRef.current
  const currentIndex = currentTabs.findIndex((t) => t.entry.path === currentPath)
  const nextIndex = (currentIndex + direction + currentTabs.length) % currentTabs.length
  onSwitchTab.current!(currentTabs[nextIndex].entry.path)
}

function navigateNote(
  visibleNotesRef: React.RefObject<VaultEntry[]>,
  activeTabPathRef: React.RefObject<string | null>,
  onReplace: React.RefObject<(entry: VaultEntry) => void>,
  onSelect: React.RefObject<(entry: VaultEntry) => void>,
  direction: 1 | -1,
) {
  const notes = visibleNotesRef.current!
  if (notes.length === 0) return

  const currentPath = activeTabPathRef.current
  const currentIndex = notes.findIndex((n) => n.path === currentPath)

  const nextIndex = currentIndex === -1
    ? (direction === 1 ? 0 : notes.length - 1)
    : (currentIndex + direction + notes.length) % notes.length

  const nextNote = notes[nextIndex]
  if (currentPath) {
    onReplace.current!(nextNote)
  } else {
    onSelect.current!(nextNote)
  }
}

export function useKeyboardNavigation({
  tabs,
  activeTabPath,
  entries,
  selection,
  allContent,
  onSwitchTab,
  onReplaceActiveTab,
  onSelectNote,
}: KeyboardNavigationOptions) {
  const visibleNotes = useMemo(
    () => computeVisibleNotes(entries, selection, allContent),
    [entries, selection, allContent],
  )

  const tabsRef = useRef(tabs)
  tabsRef.current = tabs
  const activeTabPathRef = useRef(activeTabPath)
  activeTabPathRef.current = activeTabPath
  const visibleNotesRef = useRef(visibleNotes)
  visibleNotesRef.current = visibleNotes
  const onSwitchTabRef = useRef(onSwitchTab)
  onSwitchTabRef.current = onSwitchTab
  const onReplaceRef = useRef(onReplaceActiveTab)
  onReplaceRef.current = onReplaceActiveTab
  const onSelectNoteRef = useRef(onSelectNote)
  onSelectNoteRef.current = onSelectNote

  useEffect(() => {
    const isRunningInTauri = isTauri()

    const handleKeyDown = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (!mod) return

      const isTabShortcut = isRunningInTauri
        ? e.altKey && !e.shiftKey
        : e.shiftKey && !e.altKey
      const isNoteShortcut = e.altKey && !e.shiftKey

      if (isTabShortcut && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault()
        navigateTab(tabsRef, activeTabPathRef, onSwitchTabRef, e.key === 'ArrowRight' ? 1 : -1)
      } else if (isNoteShortcut && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault()
        navigateNote(visibleNotesRef, activeTabPathRef, onReplaceRef, onSelectNoteRef, e.key === 'ArrowDown' ? 1 : -1)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])
}
