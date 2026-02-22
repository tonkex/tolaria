import { useState, useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
import { ArrowsDownUp, Check } from '@phosphor-icons/react'
import { type SortOption, SORT_OPTIONS } from '../utils/noteListHelpers'

export function SortDropdown({ groupLabel, current, onChange }: {
  groupLabel: string
  current: SortOption
  onChange: (groupLabel: string, option: SortOption) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  const handleSelect = (opt: SortOption) => {
    onChange(groupLabel, opt)
    setOpen(false)
  }

  return (
    <div ref={ref} className="relative" style={{ zIndex: open ? 10 : 0 }}>
      <button
        className={cn("flex items-center gap-0.5 rounded px-1 py-0.5 text-muted-foreground transition-colors hover:text-foreground hover:bg-accent", open && "bg-accent text-foreground")}
        onClick={(e) => { e.stopPropagation(); setOpen(!open) }}
        title={`Sort by ${current}`}
        data-testid={`sort-button-${groupLabel}`}
      >
        <ArrowsDownUp size={12} />
        <span className="text-[10px] font-medium">{SORT_OPTIONS.find((o) => o.value === current)?.label}</span>
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 rounded-md border border-border bg-popover shadow-md" style={{ width: 130, padding: 4 }} data-testid={`sort-menu-${groupLabel}`}>
          {SORT_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              className={cn("flex w-full items-center gap-1.5 rounded px-2 text-[12px] text-popover-foreground hover:bg-accent", opt.value === current && "bg-accent font-medium")}
              style={{ height: 28, border: 'none', cursor: 'pointer', background: opt.value === current ? 'var(--accent)' : 'transparent' }}
              onClick={(e) => { e.stopPropagation(); handleSelect(opt.value) }}
              data-testid={`sort-option-${opt.value}`}
            >
              {opt.value === current ? <Check size={12} /> : <span style={{ width: 12, height: 12, display: 'inline-block' }} />}
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
