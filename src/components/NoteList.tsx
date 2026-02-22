import { useState, useMemo, useCallback, memo } from 'react'
import type { VaultEntry, SidebarSelection, ModifiedFile } from '../types'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import {
  MagnifyingGlass, Plus, CaretDown, CaretRight, Warning,
} from '@phosphor-icons/react'
import { getTypeColor, getTypeLightColor } from '../utils/typeColors'
import { NoteItem, getTypeIcon } from './NoteItem'
import { SortDropdown } from './SortDropdown'
import {
  type SortOption, type RelationshipGroup,
  getSortComparator,
  buildRelationshipGroups, filterEntries,
  sortByModified, relativeDate, getDisplayDate,
  loadSortPreferences, saveSortPreferences,
} from '../utils/noteListHelpers'

// Re-export for consumers
export { sortByModified, filterEntries, buildRelationshipGroups, getSortComparator }
export type { SortOption }

interface NoteListProps {
  entries: VaultEntry[]
  selection: SidebarSelection
  selectedNote: VaultEntry | null
  allContent: Record<string, string>
  modifiedFiles?: ModifiedFile[]
  onSelectNote: (entry: VaultEntry) => void
  onCreateNote: () => void
}

function PinnedCard({ entry, typeEntryMap, onSelectNote, showDate }: {
  entry: VaultEntry
  typeEntryMap: Record<string, VaultEntry>
  onSelectNote: (entry: VaultEntry) => void
  showDate?: boolean
}) {
  const te = typeEntryMap[entry.isA ?? '']
  const color = getTypeColor(entry.isA ?? '', te?.color)
  const bgColor = getTypeLightColor(entry.isA ?? '', te?.color)
  const Icon = getTypeIcon(entry.isA, te?.icon)
  return (
    <div className="relative cursor-pointer border-b border-[var(--border)]" style={{ backgroundColor: bgColor, padding: '14px 16px' }} onClick={() => onSelectNote(entry)}>
      <Icon width={16} height={16} className="absolute right-3 top-3.5" style={{ color }} data-testid="type-icon" />
      <div className="pr-6 text-[14px] font-bold" style={{ color }}>{entry.title}</div>
      <div className="mt-1 text-[12px] leading-[1.5] opacity-80" style={{ color, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{entry.snippet}</div>
      {showDate && <div className="mt-1 text-[11px] opacity-60" style={{ color }}>{relativeDate(getDisplayDate(entry))}</div>}
    </div>
  )
}

function RelationshipGroupSection({ group, isCollapsed, sortPrefs, onToggle, handleSortChange, renderItem }: {
  group: RelationshipGroup
  isCollapsed: boolean
  sortPrefs: Record<string, SortOption>
  onToggle: () => void
  handleSortChange: (groupLabel: string, option: SortOption) => void
  renderItem: (entry: VaultEntry) => React.ReactNode
}) {
  const groupSort = sortPrefs[group.label] ?? 'modified'
  const sortedEntries = [...group.entries].sort(getSortComparator(groupSort))
  return (
    <div>
      <div className="flex w-full items-center justify-between bg-muted" style={{ height: 32, padding: '0 16px' }}>
        <button className="flex flex-1 items-center gap-1.5 border-none bg-transparent cursor-pointer p-0" onClick={onToggle}>
          <span className="font-mono-label text-muted-foreground">{group.label}</span>
          <span className="font-mono-label text-muted-foreground" style={{ fontWeight: 400 }}>{group.entries.length}</span>
        </button>
        <span className="flex items-center gap-1.5">
          <SortDropdown groupLabel={group.label} current={groupSort} onChange={handleSortChange} />
          <button className="flex items-center border-none bg-transparent cursor-pointer p-0 text-muted-foreground" onClick={onToggle}>
            {isCollapsed ? <CaretRight size={12} /> : <CaretDown size={12} />}
          </button>
        </span>
      </div>
      {!isCollapsed && sortedEntries.map((entry) => renderItem(entry))}
    </div>
  )
}

function TrashWarningBanner({ expiredCount }: { expiredCount: number }) {
  if (expiredCount === 0) return null
  return (
    <div className="flex items-start gap-2 border-b border-[var(--border)]" style={{ padding: '10px 12px', background: 'color-mix(in srgb, var(--destructive) 6%, transparent)' }}>
      <Warning size={16} className="shrink-0" style={{ color: 'var(--destructive)', marginTop: 1 }} />
      <div>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--destructive)' }}>Notes in trash for 30+ days will be permanently deleted</div>
        <div className="text-muted-foreground" style={{ fontSize: 11 }}>{expiredCount} {expiredCount === 1 ? 'note is' : 'notes are'} past the 30-day retention period</div>
      </div>
    </div>
  )
}

function EmptyMessage({ text }: { text: string }) {
  return <div className="px-4 py-8 text-center text-[13px] text-muted-foreground">{text}</div>
}

function resolveHeaderTitle(selection: SidebarSelection, typeDocument: VaultEntry | null): string {
  if (selection.kind === 'entity') return selection.entry.title
  if (typeDocument) return typeDocument.title
  if (selection.kind === 'filter' && selection.filter === 'archived') return 'Archive'
  if (selection.kind === 'filter' && selection.filter === 'trash') return 'Trash'
  return 'Notes'
}

function useTypeEntryMap(entries: VaultEntry[]) {
  return useMemo(() => {
    const map: Record<string, VaultEntry> = {}
    for (const e of entries) {
      if (e.isA === 'Type') map[e.title] = e
    }
    return map
  }, [entries])
}

function NoteListInner({ entries, selection, selectedNote, allContent, modifiedFiles, onSelectNote, onCreateNote }: NoteListProps) {
  const [search, setSearch] = useState('')
  const [searchVisible, setSearchVisible] = useState(false)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  const [sortPrefs, setSortPrefs] = useState<Record<string, SortOption>>(loadSortPreferences)

  const isEntityView = selection.kind === 'entity'
  const isTrashView = selection.kind === 'filter' && selection.filter === 'trash'

  const handleSortChange = useCallback((groupLabel: string, option: SortOption) => {
    setSortPrefs((prev) => {
      const next = { ...prev, [groupLabel]: option }
      saveSortPreferences(next)
      return next
    })
  }, [])

  const toggleGroup = useCallback((label: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(label)) next.delete(label)
      else next.add(label)
      return next
    })
  }, [])

  const typeEntryMap = useTypeEntryMap(entries)

  const typeDocument = useMemo(() => {
    if (selection.kind !== 'sectionGroup') return null
    return entries.find((e) => e.isA === 'Type' && e.title === selection.type) ?? null
  }, [selection, entries])

  const query = search.trim().toLowerCase()
  const listSort = sortPrefs['__list__'] ?? 'modified'

  const searched = useMemo(() => {
    if (isEntityView) return []
    const filtered = filterEntries(entries, selection, modifiedFiles)
    const sorted = [...filtered].sort(getSortComparator(listSort))
    return query ? sorted.filter((e) => e.title.toLowerCase().includes(query)) : sorted
  }, [entries, selection, modifiedFiles, isEntityView, listSort, query])

  const searchedGroups = useMemo(() => {
    if (!isEntityView) return []
    const groups = buildRelationshipGroups(selection.entry, entries, allContent)
    if (!query) return groups
    return groups.map((g) => ({ ...g, entries: g.entries.filter((e) => e.title.toLowerCase().includes(query)) })).filter((g) => g.entries.length > 0)
  }, [isEntityView, selection, entries, allContent, query])

  const expiredTrashCount = useMemo(() => {
    if (!isTrashView) return 0
    const now = Date.now() / 1000
    return searched.filter((e) => e.trashedAt && (now - e.trashedAt) >= 86400 * 30).length
  }, [isTrashView, searched])

  const renderItem = useCallback((entry: VaultEntry) => (
    <NoteItem key={entry.path} entry={entry} isSelected={selectedNote?.path === entry.path} typeEntryMap={typeEntryMap} onSelectNote={onSelectNote} />
  ), [selectedNote?.path, onSelectNote, typeEntryMap])

  return (
    <div className="flex flex-col overflow-hidden border-r border-border bg-card text-foreground" style={{ height: '100%' }}>
      <div className="flex h-[45px] shrink-0 items-center justify-between border-b border-border px-4" data-tauri-drag-region style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
        <h3 className="m-0 min-w-0 flex-1 truncate text-[14px] font-semibold">{resolveHeaderTitle(selection, typeDocument)}</h3>
        <div className="flex items-center gap-3" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          {!isEntityView && <SortDropdown groupLabel="__list__" current={listSort} onChange={handleSortChange} />}
          <button className="flex items-center text-muted-foreground transition-colors hover:text-foreground" onClick={() => { setSearchVisible(!searchVisible); if (searchVisible) setSearch('') }} title="Search notes">
            <MagnifyingGlass size={16} />
          </button>
          <button className="flex items-center text-muted-foreground transition-colors hover:text-foreground" onClick={onCreateNote} title="Create new note">
            <Plus size={16} />
          </button>
        </div>
      </div>

      {searchVisible && (
        <div className="border-b border-border px-3 py-2">
          <Input placeholder="Search notes..." value={search} onChange={(e) => setSearch(e.target.value)} className="h-8 text-[13px]" autoFocus />
        </div>
      )}

      <div className="flex-1 overflow-hidden" style={{ minHeight: 0 }}>
        {isEntityView ? (
          <div className="h-full overflow-y-auto">
            <PinnedCard entry={selection.entry} typeEntryMap={typeEntryMap} onSelectNote={onSelectNote} showDate />
            {searchedGroups.length === 0
              ? <EmptyMessage text={query ? 'No matching items' : 'No related items'} />
              : searchedGroups.map((group) => (
                <RelationshipGroupSection key={group.label} group={group} isCollapsed={collapsedGroups.has(group.label)} sortPrefs={sortPrefs} onToggle={() => toggleGroup(group.label)} handleSortChange={handleSortChange} renderItem={renderItem} />
              ))
            }
          </div>
        ) : (
          <div className="h-full overflow-y-auto">
            {typeDocument && <PinnedCard entry={typeDocument} typeEntryMap={typeEntryMap} onSelectNote={onSelectNote} />}
            <TrashWarningBanner expiredCount={isTrashView ? expiredTrashCount : 0} />
            {searched.length === 0
              ? <EmptyMessage text={isTrashView ? 'Trash is empty' : 'No notes found'} />
              : searched.map((entry) => renderItem(entry))
            }
          </div>
        )}
      </div>
    </div>
  )
}

export const NoteList = memo(NoteListInner)
