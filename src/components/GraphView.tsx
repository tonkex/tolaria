import { invoke } from '@tauri-apps/api/core'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ShareNetwork, ArrowsOutCardinal } from '@phosphor-icons/react'
import { isTauri, mockInvoke } from '../mock-tauri'
import type { VaultEntry } from '../types'

interface GraphViewProps {
  entries: VaultEntry[]
  activeEntry: VaultEntry | null
  vaultPath?: string | null
  onOpenNote?: (path: string) => void
  sidebarCollapsed?: boolean
  onExpandSidebar?: () => void
  embedded?: boolean
  fixedProvider?: GraphProvider
  fixedScope?: GraphScope
}

type GraphProvider = 'vault' | 'graphify'
type GraphScope = 'local' | 'full'

interface GraphNode {
  id: string
  label: string
  type: string
  path: string | null
  x: number
  y: number
  radius: number
  isActive: boolean
  status?: string | null
  aliases?: string[]
  belongsToCount?: number
  relatedToCount?: number
  outgoingCount?: number
  community?: string | number | null
  metadata?: Record<string, unknown>
}

interface GraphEdge {
  source: string
  target: string
  kind: string
  label?: string | null
}

interface GraphData {
  nodes: GraphNode[]
  edges: GraphEdge[]
  summary: string
}

interface GraphifyLoadState {
  available: boolean
  loading: boolean
  error: string | null
  graph: GraphData | null
}

interface DragState {
  id: string
  offsetX: number
  offsetY: number
}

interface PanState {
  startX: number
  startY: number
  originX: number
  originY: number
}

function edgeId(edge: Pick<GraphEdge, 'source' | 'target' | 'kind' | 'label'>): string {
  return `${edge.source}::${edge.target}::${edge.kind}::${edge.label ?? 'nolabel'}`
}

function normalizeLinkToken(token: string): string {
  const stripped = token
    .replaceAll('[[', '')
    .replaceAll(']]', '')
    .split('|')[0]
    .trim()
    .replaceAll('\\', '/')
  return stripped.replace(/\.md$/i, '')
}

function pathSuffixTokens(path: string): string[] {
  const normalized = normalizeLinkToken(path)
  const segments = normalized.split('/').filter(Boolean)
  const suffixes: string[] = []
  for (let index = 0; index < segments.length; index += 1) {
    suffixes.push(segments.slice(index).join('/'))
  }
  if (normalized.startsWith('/')) {
    suffixes.push(normalized)
  }
  return Array.from(new Set(suffixes))
}

function buildEntryIndexes(entries: VaultEntry[]) {
  const byPath = new Map<string, VaultEntry>()
  const byStem = new Map<string, VaultEntry>()
  const byTitle = new Map<string, VaultEntry>()
  const byAlias = new Map<string, VaultEntry>()

  for (const entry of entries) {
    byPath.set(entry.path, entry)
    for (const token of pathSuffixTokens(entry.path)) {
      byStem.set(token, entry)
    }
    byTitle.set(normalizeLinkToken(entry.title), entry)
    for (const alias of entry.aliases) {
      byAlias.set(normalizeLinkToken(alias), entry)
    }
  }

  return { byPath, byStem, byTitle, byAlias }
}

function resolveLinkTarget(token: string, indexes: ReturnType<typeof buildEntryIndexes>): VaultEntry | null {
  const normalized = normalizeLinkToken(token)
  return indexes.byPath.get(normalized)
    ?? indexes.byStem.get(normalized)
    ?? indexes.byTitle.get(normalized)
    ?? indexes.byAlias.get(normalized)
    ?? null
}

function layoutNeighborhoodNodes(
  nodes: Array<Omit<GraphNode, 'x' | 'y' | 'radius'>>,
  edges: GraphEdge[],
  centerNodeId: string | null,
): GraphNode[] {
  if (nodes.length === 0) return []
  const centerX = 360
  const centerY = 240
  const center = nodes.find((node) => node.id === centerNodeId) ?? nodes[0]
  const incoming: Array<Omit<GraphNode, 'x' | 'y' | 'radius'>> = []
  const outgoing: Array<Omit<GraphNode, 'x' | 'y' | 'radius'>> = []
  const related: Array<Omit<GraphNode, 'x' | 'y' | 'radius'>> = []
  const assigned = new Set<string>([center.id])

  for (const node of nodes) {
    if (node.id === center.id) continue
    const relevantEdges = edges.filter((edge) => edge.source === node.id || edge.target === node.id)
    const hasOutgoingToCenter = relevantEdges.some((edge) => edge.source === node.id && edge.target === center.id)
    const hasIncomingFromCenter = relevantEdges.some((edge) => edge.source === center.id && edge.target === node.id)
    const hasRelationship = relevantEdges.some((edge) => edge.kind === 'relationship')

    if (hasIncomingFromCenter) {
      outgoing.push(node)
      assigned.add(node.id)
    } else if (hasOutgoingToCenter) {
      incoming.push(node)
      assigned.add(node.id)
    } else if (hasRelationship) {
      related.push(node)
      assigned.add(node.id)
    }
  }

  for (const node of nodes) {
    if (!assigned.has(node.id)) related.push(node)
  }

  const placeSector = (
    sectorNodes: Array<Omit<GraphNode, 'x' | 'y' | 'radius'>>,
    startAngle: number,
    endAngle: number,
    radius: number,
  ) => sectorNodes.map((node, index) => {
    const angle = sectorNodes.length === 1
      ? (startAngle + endAngle) / 2
      : startAngle + ((endAngle - startAngle) * index) / Math.max(sectorNodes.length - 1, 1)
    return {
      ...node,
      x: centerX + Math.cos(angle) * radius,
      y: centerY + Math.sin(angle) * radius,
      radius: 22,
    }
  })

  return [
    {
      ...center,
      x: centerX,
      y: centerY,
      radius: 34,
    },
    ...placeSector(incoming, Math.PI * 0.82, Math.PI * 1.18, 190),
    ...placeSector(outgoing, -Math.PI * 0.18, Math.PI * 0.18, 190),
    ...placeSector(related, Math.PI * 0.28, Math.PI * 0.72, 155),
  ]
}

function layoutClusteredNodes(
  nodes: Array<Omit<GraphNode, 'x' | 'y' | 'radius'>>,
  groupFor: (node: Omit<GraphNode, 'x' | 'y' | 'radius'>) => string,
): GraphNode[] {
  if (nodes.length === 0) return []

  const centerX = 360
  const centerY = 240
  const groupOrbit = 155
  const nodeOrbit = 46
  const groups = new Map<string, Array<Omit<GraphNode, 'x' | 'y' | 'radius'>>>()

  for (const node of nodes) {
    const key = groupFor(node)
    const bucket = groups.get(key) ?? []
    bucket.push(node)
    groups.set(key, bucket)
  }

  const groupEntries = Array.from(groups.entries())
  return groupEntries.flatMap(([_, groupNodes], groupIndex) => {
    const groupAngle = (Math.PI * 2 * groupIndex) / Math.max(groupEntries.length, 1)
    const groupCenterX = centerX + Math.cos(groupAngle) * groupOrbit
    const groupCenterY = centerY + Math.sin(groupAngle) * groupOrbit

    if (groupNodes.length === 1) {
      const node = groupNodes[0]
      return [{
        ...node,
        x: groupCenterX,
        y: groupCenterY,
        radius: node.isActive ? 30 : 18,
      }]
    }

    return groupNodes.map((node, nodeIndex) => {
      const nodeAngle = (Math.PI * 2 * nodeIndex) / Math.max(groupNodes.length, 1)
      return {
        ...node,
        x: groupCenterX + Math.cos(nodeAngle) * nodeOrbit,
        y: groupCenterY + Math.sin(nodeAngle) * nodeOrbit,
        radius: node.isActive ? 28 : 16,
      }
    })
  })
}

function layoutForceNodes(
  nodes: Array<Omit<GraphNode, 'x' | 'y' | 'radius'>>,
  edges: GraphEdge[],
  groupFor: (node: Omit<GraphNode, 'x' | 'y' | 'radius'>) => string,
): GraphNode[] {
  if (nodes.length === 0) return []

  const seeded = layoutClusteredNodes(nodes, groupFor).map((node) => ({
    ...node,
    vx: 0,
    vy: 0,
  }))
  const indexById = new Map(seeded.map((node, index) => [node.id, index]))
  const width = 720
  const height = 480
  const centerX = width / 2
  const centerY = height / 2
  const repulsion = 9000
  const spring = 0.012
  const damping = 0.82
  const preferredLength = 92
  const ellipseRadiusX = 300
  const ellipseRadiusY = 185
  const collisionPadding = 18

  for (let step = 0; step < 110; step += 1) {
    for (let i = 0; i < seeded.length; i += 1) {
      const nodeA = seeded[i]
      for (let j = i + 1; j < seeded.length; j += 1) {
        const nodeB = seeded[j]
        const dx = nodeB.x - nodeA.x
        const dy = nodeB.y - nodeA.y
        const distSq = Math.max(dx * dx + dy * dy, 0.01)
        const dist = Math.sqrt(distSq)
        const force = repulsion / distSq
        const fx = (dx / dist) * force
        const fy = (dy / dist) * force
        nodeA.vx -= fx
        nodeA.vy -= fy
        nodeB.vx += fx
        nodeB.vy += fy

        const minDistance = (nodeA.isActive ? 28 : 16) + (nodeB.isActive ? 28 : 16) + collisionPadding
        if (dist < minDistance) {
          const overlap = (minDistance - dist) / 2
          const pushX = (dx / dist) * overlap
          const pushY = (dy / dist) * overlap
          nodeA.x -= pushX
          nodeA.y -= pushY
          nodeB.x += pushX
          nodeB.y += pushY
        }
      }
    }

    for (const edge of edges) {
      const sourceIndex = indexById.get(edge.source)
      const targetIndex = indexById.get(edge.target)
      if (sourceIndex == null || targetIndex == null) continue
      const source = seeded[sourceIndex]
      const target = seeded[targetIndex]
      const dx = target.x - source.x
      const dy = target.y - source.y
      const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 0.01)
      const delta = dist - preferredLength
      const force = delta * spring
      const fx = (dx / dist) * force
      const fy = (dy / dist) * force
      source.vx += fx
      source.vy += fy
      target.vx -= fx
      target.vy -= fy
    }

    for (const node of seeded) {
      const centerPull = node.isActive ? 0.018 : 0.01
      node.vx += (centerX - node.x) * centerPull
      node.vy += (centerY - node.y) * centerPull

      const normalizedX = (node.x - centerX) / ellipseRadiusX
      const normalizedY = (node.y - centerY) / ellipseRadiusY
      const ellipseDistance = normalizedX * normalizedX + normalizedY * normalizedY
      if (ellipseDistance > 1) {
        const overflow = ellipseDistance - 1
        node.vx -= normalizedX * overflow * 18
        node.vy -= normalizedY * overflow * 18
      }

      node.vx *= damping
      node.vy *= damping
      node.x += node.vx
      node.y += node.vy
      node.x = Math.max(28, Math.min(width - 28, node.x))
      node.y = Math.max(28, Math.min(height - 28, node.y))
    }
  }

  const outerNodes = seeded
    .map((node, index) => {
      const normalizedX = (node.x - centerX) / ellipseRadiusX
      const normalizedY = (node.y - centerY) / ellipseRadiusY
      const ellipseDistance = normalizedX * normalizedX + normalizedY * normalizedY
      return {
        index,
        node,
        ellipseDistance,
        angle: Math.atan2(node.y - centerY, node.x - centerX),
      }
    })
    .filter((entry) => entry.ellipseDistance > 0.58)
    .sort((left, right) => left.angle - right.angle)

  if (outerNodes.length > 1) {
    const minGap = Math.min(0.34, (Math.PI * 2) / outerNodes.length * 0.72)
    let previousAngle = outerNodes[0].angle
    for (let index = 1; index < outerNodes.length; index += 1) {
      const current = outerNodes[index]
      if (current.angle - previousAngle < minGap) {
        current.angle = previousAngle + minGap
      }
      previousAngle = current.angle
    }

    const totalSpan = outerNodes[outerNodes.length - 1].angle - outerNodes[0].angle
    if (totalSpan > Math.PI * 2 - minGap) {
      for (let index = 0; index < outerNodes.length; index += 1) {
        outerNodes[index].angle = outerNodes[0].angle + index * minGap
      }
    }

    for (const entry of outerNodes) {
      const radialScale = entry.node.isActive ? 0.84 : 0.91
      entry.node.x = centerX + Math.cos(entry.angle) * ellipseRadiusX * radialScale
      entry.node.y = centerY + Math.sin(entry.angle) * ellipseRadiusY * radialScale
    }
  }

  return seeded.map(({ vx: _vx, vy: _vy, ...node }) => ({
    ...node,
    radius: node.isActive ? 28 : 16,
  }))
}

function collectVaultGraph(entries: VaultEntry[], activeEntry: VaultEntry | null, scope: GraphScope): GraphData {
  if (!activeEntry && scope === 'local') return { nodes: [], edges: [], summary: '노트를 열면 local graph를 계산합니다.' }
  const indexes = buildEntryIndexes(entries)
  const nodeMap = new Map<string, VaultEntry>()
  const edgeMap = new Map<string, GraphEdge>()
  if (activeEntry) nodeMap.set(activeEntry.path, activeEntry)

  const registerEdge = (source: VaultEntry, target: VaultEntry, kind: string) => {
    if (source.path === target.path) return
    nodeMap.set(source.path, source)
    nodeMap.set(target.path, target)
    const key = [source.path, target.path, kind].join('::')
    if (!edgeMap.has(key)) edgeMap.set(key, { source: source.path, target: target.path, kind, label: null })
  }

  const seedConnections = (entry: VaultEntry) => {
    for (const outgoing of entry.outgoingLinks) {
      const target = resolveLinkTarget(outgoing, indexes)
      if (target) registerEdge(entry, target, 'wikilink')
    }

    for (const rel of [...entry.belongsTo, ...entry.relatedTo]) {
      const target = resolveLinkTarget(rel, indexes)
      if (target) {
        const label = entry.belongsTo.includes(rel) ? 'belongs_to' : 'related_to'
        const key = [entry.path, target.path, 'relationship', label].join('::')
        nodeMap.set(entry.path, entry)
        nodeMap.set(target.path, target)
        if (!edgeMap.has(key)) edgeMap.set(key, { source: entry.path, target: target.path, kind: 'relationship', label })
      }
    }

    for (const [relationshipKey, values] of Object.entries(entry.relationships)) {
      for (const rel of values) {
        const target = resolveLinkTarget(rel, indexes)
        if (target) {
          const key = [entry.path, target.path, 'relationship', relationshipKey].join('::')
          nodeMap.set(entry.path, entry)
          nodeMap.set(target.path, target)
          if (!edgeMap.has(key)) edgeMap.set(key, { source: entry.path, target: target.path, kind: 'relationship', label: relationshipKey })
        }
      }
    }
  }

  if (scope === 'full') {
    for (const entry of entries) {
      seedConnections(entry)
    }
  } else if (activeEntry) {
    seedConnections(activeEntry)

    for (const entry of entries) {
      if (entry.path === activeEntry.path) continue
      const linksBack = entry.outgoingLinks.some((token) => resolveLinkTarget(token, indexes)?.path === activeEntry.path)
      const relBack = [...entry.belongsTo, ...entry.relatedTo].some((token) => resolveLinkTarget(token, indexes)?.path === activeEntry.path)
        || Object.values(entry.relationships).flat().some((token) => resolveLinkTarget(token, indexes)?.path === activeEntry.path)
      if (linksBack || relBack) {
        registerEdge(entry, activeEntry, linksBack ? 'wikilink' : 'relationship')
      }
    }
  }

  const baseNodes = Array.from(nodeMap.values()).map((entry) => ({
    id: entry.path,
    label: entry.title,
    type: entry.isA ?? 'note',
    path: entry.path,
    isActive: entry.path === activeEntry?.path,
    status: entry.status,
    aliases: entry.aliases,
    belongsToCount: entry.belongsTo.length,
    relatedToCount: entry.relatedTo.length,
    outgoingCount: entry.outgoingLinks.length,
    community: null,
    metadata: entry.properties,
  }))
  const nodes = scope === 'full'
    ? layoutForceNodes(baseNodes, Array.from(edgeMap.values()), (node) => (node.type || 'note').toLowerCase())
    : layoutNeighborhoodNodes(baseNodes, Array.from(edgeMap.values()), activeEntry?.path ?? entries[0]?.path ?? null)

  return {
    nodes,
    edges: Array.from(edgeMap.values()),
    summary: scope === 'full'
      ? 'all vault notes linked by wikilinks / relationships'
      : 'active note + 1-hop backlinks / outgoing / relationships',
  }
}

function resolveGraphifyNodeId(raw: Record<string, unknown>): string | null {
  const direct = raw.id ?? raw.key ?? raw.name ?? raw.label ?? raw.title
  return typeof direct === 'string' && direct.trim() ? direct : null
}

function parseGraphifyJson(rawText: string, activeEntry: VaultEntry | null): GraphData {
  const parsed = JSON.parse(rawText) as Record<string, unknown>
  const container = (parsed.graph && typeof parsed.graph === 'object' ? parsed.graph : parsed) as Record<string, unknown>
  const rawNodes = Array.isArray(container.nodes) ? container.nodes as Record<string, unknown>[] : []
  const rawEdges = Array.isArray(container.edges)
    ? container.edges as Record<string, unknown>[]
    : Array.isArray(container.links)
      ? container.links as Record<string, unknown>[]
      : []

  const activePathStem = activeEntry ? normalizeLinkToken(activeEntry.path) : null
  const mappedNodes: Array<Omit<GraphNode, 'x' | 'y' | 'radius'> | null> = rawNodes
    .map((rawNode) => {
      const id = resolveGraphifyNodeId(rawNode)
      if (!id) return null
      const pathCandidate = rawNode.path ?? rawNode.file ?? rawNode.source_file ?? (rawNode.metadata as Record<string, unknown> | undefined)?.path
      const path = typeof pathCandidate === 'string' && pathCandidate.trim() ? pathCandidate : null
      const typeCandidate = rawNode.type ?? rawNode.kind ?? rawNode.category ?? rawNode.node_type
      const communityCandidate = rawNode.community ?? rawNode.cluster ?? rawNode.group
      const aliases = Array.isArray(rawNode.aliases)
        ? rawNode.aliases.filter((value): value is string => typeof value === 'string')
        : []
      const label = [rawNode.label, rawNode.name, rawNode.title, id].find((value): value is string => typeof value === 'string' && value.trim().length > 0) ?? id
      const isActive = Boolean(
        activePathStem
        && path
        && normalizeLinkToken(path) === activePathStem,
      )
      return {
        id,
        label,
        type: typeof typeCandidate === 'string' && typeCandidate.trim() ? typeCandidate : 'graphify',
        path,
        isActive,
        status: null,
        aliases,
        belongsToCount: undefined,
        relatedToCount: undefined,
        outgoingCount: undefined,
        community: typeof communityCandidate === 'string' || typeof communityCandidate === 'number' ? communityCandidate : null,
        metadata: rawNode,
      }
    })
  const baseNodes = mappedNodes.filter((node): node is Omit<GraphNode, 'x' | 'y' | 'radius'> => node !== null)

  const mappedEdges: Array<GraphEdge | null> = rawEdges
    .map((rawEdge) => {
      const sourceRaw = rawEdge.source
      const targetRaw = rawEdge.target
      const source = typeof sourceRaw === 'string'
        ? sourceRaw
        : sourceRaw && typeof sourceRaw === 'object'
          ? resolveGraphifyNodeId(sourceRaw as Record<string, unknown>)
          : null
      const target = typeof targetRaw === 'string'
        ? targetRaw
        : targetRaw && typeof targetRaw === 'object'
          ? resolveGraphifyNodeId(targetRaw as Record<string, unknown>)
          : null
      if (!source || !target) return null
      return {
        source,
        target,
        kind: [rawEdge.type, rawEdge.kind, rawEdge.label].find((value): value is string => typeof value === 'string' && value.trim().length > 0) ?? 'graphify',
        label: [rawEdge.label, rawEdge.relationship, rawEdge.relation].find((value): value is string => typeof value === 'string' && value.trim().length > 0) ?? null,
      }
    })
  const edges = mappedEdges.filter((edge): edge is GraphEdge => edge !== null)

  const nodes = layoutForceNodes(
    baseNodes,
    edges,
    (node) => String(node.community ?? (node.type || 'graphify')).toLowerCase(),
  )

  return {
    nodes,
    edges,
    summary: 'graphify-out/graph.json imported graph',
  }
}

function nodeFill(node: GraphNode) {
  if (node.isActive) return 'var(--primary)'
  switch ((node.type || '').toLowerCase()) {
    case 'concept': return 'var(--accent-blue)'
    case 'method': return 'var(--accent-green)'
    case 'topic': return 'var(--accent-orange)'
    case 'paper': return 'var(--accent-purple)'
    case 'comparison': return 'var(--accent-yellow)'
    case 'roadmap': return 'var(--accent-red)'
    default: return 'var(--muted-foreground)'
  }
}

function nodeLabelFill(node: GraphNode) {
  if (node.isActive) return 'white'
  return 'rgba(255, 255, 255, 0.92)'
}

function propertyValueForNode(node: GraphNode, propertyKey: string): string | null {
  if (!propertyKey) return null
  const value = node.metadata?.[propertyKey]
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  return null
}

function filterGraphData(
  graph: GraphData,
  typeFilter: string,
  communityFilter: string,
  propertyKeyFilter: string,
  propertyValueFilter: string,
): GraphData {
  const keptNodes = graph.nodes.filter((node) => {
    const matchesType = typeFilter === 'all' || (node.type || '').toLowerCase() === typeFilter
    const matchesCommunity = communityFilter === 'all' || String(node.community ?? '') === communityFilter
    const propertyValue = propertyValueForNode(node, propertyKeyFilter)
    const matchesPropertyKey = propertyKeyFilter === 'all' || propertyValue !== null
    const matchesPropertyValue = propertyValueFilter === 'all' || propertyValue === propertyValueFilter
    return matchesType && matchesCommunity && matchesPropertyKey && matchesPropertyValue
  })
  const keptNodeIds = new Set(keptNodes.map((node) => node.id))
  const keptEdges = graph.edges.filter((edge) => keptNodeIds.has(edge.source) && keptNodeIds.has(edge.target))
  return {
    ...graph,
    nodes: keptNodes,
    edges: keptEdges,
  }
}

function graphifyFilePath(vaultPath: string) {
  return `${vaultPath.replace(/\/+$/, '')}/graphify-out/graph.json`
}

async function loadGraphifyGraph(vaultPath: string): Promise<GraphifyLoadState> {
  try {
    const path = graphifyFilePath(vaultPath)
    const request = { path, vaultPath }
    const raw = isTauri()
      ? await invoke<string>('get_note_content', request)
      : await mockInvoke<string>('get_note_content', request)
    return {
      available: true,
      loading: false,
      error: null,
      graph: raw ? parseGraphifyJson(raw, null) : null,
    }
  } catch (error) {
    return {
      available: false,
      loading: false,
      error: error instanceof Error ? error.message : 'Failed to load graphify graph',
      graph: null,
    }
  }
}

function providerButtonClass(active: boolean) {
  return active
    ? 'rounded-md bg-[var(--primary)] px-2 py-1 text-xs font-semibold text-white'
    : 'rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground'
}

const TYPE_LEGEND = [
  { label: 'concept', color: 'var(--accent-blue)' },
  { label: 'method', color: 'var(--accent-green)' },
  { label: 'topic', color: 'var(--accent-orange)' },
  { label: 'paper', color: 'var(--accent-purple)' },
  { label: 'comparison', color: 'var(--accent-yellow)' },
  { label: 'other', color: 'var(--muted-foreground)' },
]

export function GraphView({
  entries,
  activeEntry,
  vaultPath,
  onOpenNote,
  sidebarCollapsed,
  onExpandSidebar,
  embedded = false,
  fixedProvider,
  fixedScope,
}: GraphViewProps) {
  const [provider, setProvider] = useState<GraphProvider>(fixedProvider ?? 'vault')
  const [scope, setScope] = useState<GraphScope>(fixedScope ?? 'local')
  const [typeFilter, setTypeFilter] = useState('all')
  const [communityFilter, setCommunityFilter] = useState('all')
  const [propertyKeyFilter, setPropertyKeyFilter] = useState('all')
  const [propertyValueFilter, setPropertyValueFilter] = useState('all')
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(activeEntry?.path ?? null)
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null)
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null)
  const [focusNeighborhood, setFocusNeighborhood] = useState(false)
  const [pinnedPositions, setPinnedPositions] = useState<Record<string, { x: number; y: number }>>({})
  const [dragState, setDragState] = useState<DragState | null>(null)
  const [panState, setPanState] = useState<PanState | null>(null)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [graphifyState, setGraphifyState] = useState<GraphifyLoadState>({
    available: false,
    loading: false,
    error: null,
    graph: null,
  })
  const svgRef = useRef<SVGSVGElement | null>(null)

  useEffect(() => {
    if (fixedProvider) setProvider(fixedProvider)
  }, [fixedProvider])

  useEffect(() => {
    if (fixedScope) setScope(fixedScope)
  }, [fixedScope])

  const vaultGraph = useMemo(() => collectVaultGraph(entries, activeEntry, scope), [entries, activeEntry, scope])

  useEffect(() => {
    setSelectedNodeId(activeEntry?.path ?? null)
  }, [activeEntry?.path])

  useEffect(() => {
    let cancelled = false
    if (!vaultPath) {
      setGraphifyState({ available: false, loading: false, error: null, graph: null })
      return
    }

    setGraphifyState((current) => ({ ...current, loading: true }))
    void loadGraphifyGraph(vaultPath).then((state) => {
      if (cancelled) return
      const graph = state.graph
        ? parseGraphifyJson(
          JSON.stringify({
            nodes: state.graph.nodes.map((node) => node.metadata ?? { id: node.id, label: node.label, type: node.type, path: node.path, community: node.community }),
            edges: state.graph.edges,
          }),
          activeEntry,
        )
        : null
      setGraphifyState({
        ...state,
        graph,
      })
    })

    return () => {
      cancelled = true
    }
  }, [vaultPath, activeEntry])

  useEffect(() => {
    setTypeFilter('all')
    setCommunityFilter('all')
    setPropertyKeyFilter('all')
    setPropertyValueFilter('all')
    setZoom(1)
    setPan({ x: 0, y: 0 })
  }, [provider, scope])

  const sourceGraph = provider === 'graphify' && graphifyState.available && graphifyState.graph
    ? graphifyState.graph
    : vaultGraph
  const availableTypes = useMemo(
    () => Array.from(new Set(sourceGraph.nodes.map((node) => (node.type || '').toLowerCase()).filter(Boolean))).sort(),
    [sourceGraph.nodes],
  )
  const availableCommunities = useMemo(
    () => Array.from(new Set(sourceGraph.nodes.map((node) => node.community).filter((value): value is string | number => value != null))).map(String).sort(),
    [sourceGraph.nodes],
  )
  const availablePropertyKeys = useMemo(
    () => Array.from(new Set(sourceGraph.nodes.flatMap((node) => Object.keys(node.metadata ?? {})))).sort(),
    [sourceGraph.nodes],
  )
  const availablePropertyValues = useMemo(() => {
    if (propertyKeyFilter === 'all') return []
    return Array.from(new Set(
      sourceGraph.nodes
        .map((node) => propertyValueForNode(node, propertyKeyFilter))
        .filter((value): value is string => value !== null),
    )).sort()
  }, [sourceGraph.nodes, propertyKeyFilter])
  const filteredGraph = useMemo(
    () => filterGraphData(sourceGraph, typeFilter, communityFilter, propertyKeyFilter, propertyValueFilter),
    [sourceGraph, typeFilter, communityFilter, propertyKeyFilter, propertyValueFilter],
  )
  const graph = useMemo(() => {
    if (!focusNeighborhood || !selectedNodeId) return filteredGraph
    const neighborIds = new Set<string>([selectedNodeId])
    for (const edge of filteredGraph.edges) {
      if (edge.source === selectedNodeId) neighborIds.add(edge.target)
      if (edge.target === selectedNodeId) neighborIds.add(edge.source)
    }
    return {
      ...filteredGraph,
      nodes: filteredGraph.nodes.filter((node) => neighborIds.has(node.id)),
      edges: filteredGraph.edges.filter((edge) => neighborIds.has(edge.source) && neighborIds.has(edge.target)),
      summary: `${filteredGraph.summary} · focused neighborhood`,
    }
  }, [filteredGraph, focusNeighborhood, selectedNodeId])
  const displayGraph = useMemo(() => ({
    ...graph,
    nodes: graph.nodes.map((node) => {
      const pinned = pinnedPositions[node.id]
      return pinned ? { ...node, x: pinned.x, y: pinned.y } : node
    }),
  }), [graph, pinnedPositions])

  const nodeLookup = useMemo(() => new Map(displayGraph.nodes.map((node) => [node.id, node])), [displayGraph.nodes])
  const selectedNode = selectedNodeId ? nodeLookup.get(selectedNodeId) ?? null : displayGraph.nodes[0] ?? null
  const hoveredNode = hoveredNodeId ? nodeLookup.get(hoveredNodeId) ?? null : null
  const hoveredEdge = useMemo(() => {
    if (!hoveredEdgeId) return null
    const edge = displayGraph.edges.find((item) => edgeId(item) === hoveredEdgeId)
    if (!edge) return null
    const source = nodeLookup.get(edge.source)
    const target = nodeLookup.get(edge.target)
    if (!source || !target) return null
    return {
      ...edge,
      id: hoveredEdgeId,
      sourceNode: source,
      targetNode: target,
      midX: (source.x + target.x) / 2,
      midY: (source.y + target.y) / 2,
    }
  }, [displayGraph.edges, hoveredEdgeId, nodeLookup])
  const selectedConnections = useMemo(() => {
    if (!selectedNode) return []
    return displayGraph.edges
      .filter((edge) => edge.source === selectedNode.id || edge.target === selectedNode.id)
      .map((edge) => {
        const peerId = edge.source === selectedNode.id ? edge.target : edge.source
        const peer = nodeLookup.get(peerId)
        return {
          ...edge,
          peer,
          direction: edge.source === selectedNode.id ? 'outgoing' : 'incoming',
        }
      })
      .filter((edge) => edge.peer)
  }, [displayGraph.edges, nodeLookup, selectedNode])
  const selectedIncidentEdgeIds = useMemo(() => new Set(
    selectedNode
      ? displayGraph.edges
        .filter((edge) => edge.source === selectedNode.id || edge.target === selectedNode.id)
        .map((edge) => edgeId(edge))
      : [],
  ), [displayGraph.edges, selectedNode])

  useEffect(() => {
    if (!selectedNodeId && graph.nodes[0]) {
      setSelectedNodeId(graph.nodes[0].id)
      return
    }
    if (selectedNodeId && !nodeLookup.has(selectedNodeId)) {
      setSelectedNodeId(graph.nodes[0]?.id ?? null)
    }
  }, [displayGraph.nodes, nodeLookup, selectedNodeId])

  useEffect(() => {
    if (hoveredNodeId && !nodeLookup.has(hoveredNodeId)) {
      setHoveredNodeId(null)
    }
  }, [hoveredNodeId, nodeLookup])

  useEffect(() => {
    if (hoveredEdgeId && !displayGraph.edges.some((edge) => edgeId(edge) === hoveredEdgeId)) {
      setHoveredEdgeId(null)
    }
  }, [displayGraph.edges, hoveredEdgeId])

  useEffect(() => {
    const validIds = new Set(displayGraph.nodes.map((node) => node.id))
    setPinnedPositions((current) => Object.fromEntries(
      Object.entries(current).filter(([id]) => validIds.has(id)),
    ))
  }, [displayGraph.nodes])

  const graphUnavailable = provider === 'graphify' && !graphifyState.available

  const updateDraggedNode = (clientX: number, clientY: number) => {
    if (!dragState || !svgRef.current) return
    const rect = svgRef.current.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return
    const x = ((clientX - rect.left) / rect.width) * 720
    const y = ((clientY - rect.top) / rect.height) * 480
    const graphX = (x - pan.x) / zoom - dragState.offsetX
    const graphY = (y - pan.y) / zoom - dragState.offsetY
    setPinnedPositions((current) => ({
      ...current,
      [dragState.id]: {
        x: Math.max(20, Math.min(700, graphX)),
        y: Math.max(20, Math.min(460, graphY)),
      },
    }))
  }

  const updatePan = (clientX: number, clientY: number) => {
    if (!panState) return
    setPan({
      x: panState.originX + (clientX - panState.startX),
      y: panState.originY + (clientY - panState.startY),
    })
  }

  return (
    <div className={embedded
      ? 'flex h-full flex-col overflow-hidden bg-background'
      : 'flex h-full flex-col overflow-hidden border-r border-[var(--sidebar-border)] bg-background'}
    >
      {!embedded && (
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <ShareNetwork size={18} />
          <div>
            <div className="text-sm font-semibold">Graph</div>
            <div className="text-xs text-muted-foreground">
              {provider === 'vault'
                ? (activeEntry ? `${activeEntry.title} 주변 링크 구조` : '노트를 열면 local graph를 표시합니다')
                : 'graphify-out/graph.json 기반 richer graph'}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className={providerButtonClass(scope === 'local')}
            onClick={() => setScope('local')}
          >
            Local
          </button>
          <button
            type="button"
            className={providerButtonClass(scope === 'full')}
            onClick={() => setScope('full')}
          >
            Full
          </button>
          <button type="button" className={providerButtonClass(provider === 'vault')} onClick={() => setProvider('vault')}>
            Vault
          </button>
          <button
            type="button"
            className={providerButtonClass(provider === 'graphify')}
            onClick={() => setProvider('graphify')}
            disabled={!graphifyState.available}
            title={graphifyState.available ? 'Use graphify graph' : 'graphify-out/graph.json not found yet'}
          >
            Graphify
          </button>
          {sidebarCollapsed && onExpandSidebar && (
            <button
              type="button"
              className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              onClick={onExpandSidebar}
              title="Expand sidebar"
            >
              <ArrowsOutCardinal size={16} />
            </button>
          )}
        </div>
      </div>
      )}

      {!activeEntry && provider === 'vault' ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
          Graph View는 현재 열려 있는 노트를 중심으로 local graph를 보여줍니다.
        </div>
      ) : graphifyState.loading && provider === 'graphify' ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
          graphify graph를 읽는 중입니다.
        </div>
      ) : graphUnavailable ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
          <div>
            <div>graphify-out/graph.json 이 아직 없습니다.</div>
            <div className="mt-1 text-xs">
              먼저 Graphify를 실행한 뒤 다시 열면 provider를 전환할 수 있습니다.
            </div>
          </div>
        </div>
      ) : graph.nodes.length <= 1 ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
          {provider === 'vault'
            ? '이 노트에는 아직 시각화할 링크 연결이 충분하지 않습니다.'
            : graphifyState.error ?? 'graphify graph를 표시할 수 없습니다.'}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className={embedded
              ? 'flex flex-wrap items-center gap-3 border-b border-border px-4 py-2 text-xs text-muted-foreground'
              : 'flex flex-wrap items-center gap-3 px-4 py-2 text-xs text-muted-foreground'}
            >
              <span>nodes {graph.nodes.length}</span>
              <span>edges {graph.edges.length}</span>
              <span>{graph.summary}</span>
              {!fixedScope && (
              <label className="ml-auto flex items-center gap-2">
                <span>type</span>
                <select
                  className="rounded border border-border bg-background px-2 py-1 text-xs text-foreground"
                  value={typeFilter}
                  onChange={(event) => setTypeFilter(event.target.value)}
                >
                  <option value="all">all</option>
                  {availableTypes.map((value) => (
                    <option key={value} value={value}>{value}</option>
                  ))}
                </select>
              </label>
              )}
              {fixedScope && <span className="ml-auto" />}
              {availableCommunities.length > 0 && (
                <label className="flex items-center gap-2">
                  <span>community</span>
                  <select
                    className="rounded border border-border bg-background px-2 py-1 text-xs text-foreground"
                    value={communityFilter}
                    onChange={(event) => setCommunityFilter(event.target.value)}
                  >
                    <option value="all">all</option>
                    {availableCommunities.map((value) => (
                      <option key={value} value={value}>{value}</option>
                    ))}
                  </select>
                </label>
              )}
              {availablePropertyKeys.length > 0 && (
                <label className="flex items-center gap-2">
                  <span>property</span>
                  <select
                    className="rounded border border-border bg-background px-2 py-1 text-xs text-foreground"
                    value={propertyKeyFilter}
                    onChange={(event) => {
                      setPropertyKeyFilter(event.target.value)
                      setPropertyValueFilter('all')
                    }}
                  >
                    <option value="all">all</option>
                    {availablePropertyKeys.map((value) => (
                      <option key={value} value={value}>{value}</option>
                    ))}
                  </select>
                </label>
              )}
              {propertyKeyFilter !== 'all' && availablePropertyValues.length > 0 && (
                <label className="flex items-center gap-2">
                  <span>value</span>
                  <select
                    className="rounded border border-border bg-background px-2 py-1 text-xs text-foreground"
                    value={propertyValueFilter}
                    onChange={(event) => setPropertyValueFilter(event.target.value)}
                  >
                    <option value="all">all</option>
                    {availablePropertyValues.map((value) => (
                      <option key={value} value={value}>{value}</option>
                    ))}
                  </select>
                </label>
              )}
              <button
                type="button"
                className={providerButtonClass(focusNeighborhood)}
                onClick={() => setFocusNeighborhood((current) => !current)}
              >
                Focus Neighbors
              </button>
              <span className="rounded-md border border-border px-2 py-1 text-xs text-foreground">
                {Math.round(zoom * 100)}%
              </span>
              <button
                type="button"
                className={providerButtonClass(false)}
                onClick={() => {
                  setZoom(1)
                  setPan({ x: 0, y: 0 })
                }}
              >
                Reset View
              </button>
              {!!Object.keys(pinnedPositions).length && (
                <button
                  type="button"
                  className={providerButtonClass(false)}
                  onClick={() => setPinnedPositions({})}
                >
                  Reset Pins
                </button>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-3 px-4 pb-2 text-[11px] text-muted-foreground">
              <span className="font-medium text-foreground">Legend</span>
              {TYPE_LEGEND.map((item) => (
                <span key={item.label} className="inline-flex items-center gap-1">
                  <span
                    className="inline-block h-2.5 w-2.5 rounded-full"
                    style={{ backgroundColor: item.color }}
                  />
                  <span>{item.label}</span>
                </span>
              ))}
              <span className="ml-2 inline-flex items-center gap-1">
                <span className="inline-block h-[2px] w-4 bg-[var(--border-primary)]" />
                <span>wikilink</span>
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="inline-block h-[2px] w-4 bg-[var(--muted-foreground)] opacity-50" />
                <span>relationship</span>
              </span>
            </div>
            <div className="min-h-0 flex-1 overflow-hidden px-3 pb-3">
              <div className="relative h-full w-full">
                <svg
                  ref={svgRef}
                  viewBox="0 0 720 480"
                  className="h-full w-full rounded-lg border border-border bg-[color:var(--sidebar)]"
                  onWheel={(event) => {
                    event.preventDefault()
                    const nextZoom = Math.max(0.5, Math.min(2.5, zoom + (event.deltaY < 0 ? 0.1 : -0.1)))
                    setZoom(nextZoom)
                  }}
                  onMouseMove={(event) => {
                    updateDraggedNode(event.clientX, event.clientY)
                    updatePan(event.clientX, event.clientY)
                  }}
                  onMouseUp={() => {
                    setDragState(null)
                    setPanState(null)
                  }}
                  onMouseLeave={() => {
                    setDragState(null)
                    setPanState(null)
                    setHoveredNodeId(null)
                    setHoveredEdgeId(null)
                  }}
                  onMouseDown={(event) => {
                    const target = event.target as Element
                    if (target.tagName.toLowerCase() === 'svg' || target.tagName.toLowerCase() === 'line') {
                      setPanState({
                        startX: event.clientX,
                        startY: event.clientY,
                        originX: pan.x,
                        originY: pan.y,
                      })
                    }
                  }}
                >
                <g transform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}>
                {displayGraph.edges.map((edge) => {
                  const source = nodeLookup.get(edge.source)
                  const target = nodeLookup.get(edge.target)
                  if (!source || !target) return null
                  const currentEdgeId = edgeId(edge)
                  const isHovered = hoveredEdgeId === currentEdgeId
                  const isSelectedPath = selectedIncidentEdgeIds.has(currentEdgeId)
                  const isDimmed = selectedNode != null && !isSelectedPath && !isHovered
                  const stroke = isHovered
                    ? 'var(--primary)'
                    : isSelectedPath
                      ? edge.kind === 'wikilink'
                        ? 'var(--accent-blue)'
                        : 'var(--accent-orange)'
                      : edge.kind === 'wikilink'
                        ? 'var(--border-primary)'
                        : 'var(--muted-foreground)'
                  const strokeOpacity = isHovered
                    ? 0.95
                    : isSelectedPath
                      ? 0.92
                      : isDimmed
                        ? 0.1
                        : edge.kind === 'wikilink'
                          ? 0.7
                          : 0.35
                  const strokeWidth = isHovered
                    ? 3.5
                    : isSelectedPath
                      ? 3
                      : edge.kind === 'wikilink'
                        ? 2
                        : 1.5
                  return (
                    <line
                      key={currentEdgeId}
                      x1={source.x}
                      y1={source.y}
                      x2={target.x}
                      y2={target.y}
                      stroke={stroke}
                      strokeOpacity={strokeOpacity}
                      strokeWidth={strokeWidth}
                      style={{ cursor: 'pointer' }}
                      onMouseEnter={() => setHoveredEdgeId(currentEdgeId)}
                      onMouseLeave={() => setHoveredEdgeId((current) => (current === currentEdgeId ? null : current))}
                    />
                  )
                })}
                {displayGraph.nodes.map((node) => (
                  <g
                    key={node.id}
                    style={{ cursor: 'pointer' }}
                    onClick={() => setSelectedNodeId(node.id)}
                    onDoubleClick={() => node.path && onOpenNote?.(node.path)}
                    onMouseDown={(event) => {
                      event.preventDefault()
                      setSelectedNodeId(node.id)
                      const rect = svgRef.current?.getBoundingClientRect()
                      if (!rect || rect.width <= 0 || rect.height <= 0) return
                      const x = ((event.clientX - rect.left) / rect.width) * 720
                      const y = ((event.clientY - rect.top) / rect.height) * 480
                      const graphX = (x - pan.x) / zoom
                      const graphY = (y - pan.y) / zoom
                      setDragState({
                        id: node.id,
                        offsetX: graphX - node.x,
                        offsetY: graphY - node.y,
                      })
                    }}
                    onMouseEnter={() => setHoveredNodeId(node.id)}
                    onMouseLeave={() => setHoveredNodeId((current) => (current === node.id ? null : current))}
                  >
                    <circle
                      cx={node.x}
                      cy={node.y}
                      r={node.radius}
                      fill={nodeFill(node)}
                      opacity={node.isActive ? 0.95 : 0.85}
                      stroke={selectedNodeId === node.id ? 'white' : 'transparent'}
                      strokeWidth={selectedNodeId === node.id ? 3 : 0}
                    />
                    <text
                      x={node.x}
                      y={node.y + 4}
                      textAnchor="middle"
                      fontSize={node.isActive ? 12 : 10}
                      fontWeight={node.isActive ? 700 : 600}
                      fill={nodeLabelFill(node)}
                    >
                      {node.label.length > 18 ? `${node.label.slice(0, 18)}…` : node.label}
                    </text>
                  </g>
                ))}
                </g>
                </svg>
                {hoveredNode && (
                  <div className="pointer-events-none absolute left-3 top-3 max-w-[280px] rounded-lg border border-border bg-background/95 px-3 py-2 text-xs shadow-lg backdrop-blur">
                    <div className="font-semibold text-foreground">{hoveredNode.label}</div>
                    <div className="mt-1 text-muted-foreground">
                      <span>{hoveredNode.type}</span>
                      {hoveredNode.status && <span className="ml-2">status: {hoveredNode.status}</span>}
                      {hoveredNode.aliases && hoveredNode.aliases.length > 0 && <span className="ml-2">aliases: {hoveredNode.aliases.length}</span>}
                    </div>
                    {hoveredNode.path && (
                      <div className="mt-1 break-all text-[11px] text-muted-foreground">
                        {hoveredNode.path}
                      </div>
                    )}
                  </div>
                )}
                {hoveredEdge && (
                  <div
                    className="pointer-events-none absolute max-w-[240px] -translate-x-1/2 -translate-y-full rounded-lg border border-border bg-background/95 px-3 py-2 text-xs shadow-lg backdrop-blur"
                    style={{
                      left: `${((hoveredEdge.midX * zoom) + pan.x) / 720 * 100}%`,
                      top: `${((hoveredEdge.midY * zoom) + pan.y) / 480 * 100}%`,
                    }}
                  >
                    <div className="font-semibold text-foreground">
                      {hoveredEdge.label ?? hoveredEdge.kind}
                    </div>
                    <div className="mt-1 text-muted-foreground">
                      {hoveredEdge.sourceNode.label} → {hoveredEdge.targetNode.label}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          <aside className="max-h-72 overflow-auto border-t border-border bg-[color:var(--sidebar)] p-4">
            {!selectedNode ? (
              <div className="text-sm text-muted-foreground">노드를 선택하면 세부 정보를 보여줍니다.</div>
            ) : (
              <div className="space-y-4">
                <div>
                  <div className="text-xs uppercase tracking-wide text-muted-foreground">Selected Node</div>
                  <div className="mt-1 text-base font-semibold">{selectedNode.label}</div>
                  <div className="mt-1 text-xs text-muted-foreground">{selectedNode.type}</div>
                </div>

                <div className="space-y-2 text-sm">
                  {selectedNode.path && (
                    <div>
                      <div className="text-xs uppercase tracking-wide text-muted-foreground">Path</div>
                      <div className="break-all">{selectedNode.path}</div>
                    </div>
                  )}
                  {selectedNode.status && (
                    <div>
                      <div className="text-xs uppercase tracking-wide text-muted-foreground">Status</div>
                      <div>{selectedNode.status}</div>
                    </div>
                  )}
                  {selectedNode.community != null && (
                    <div>
                      <div className="text-xs uppercase tracking-wide text-muted-foreground">Community</div>
                      <div>{String(selectedNode.community)}</div>
                    </div>
                  )}
                  {selectedNode.aliases && selectedNode.aliases.length > 0 && (
                    <div>
                      <div className="text-xs uppercase tracking-wide text-muted-foreground">Aliases</div>
                      <div>{selectedNode.aliases.join(', ')}</div>
                    </div>
                  )}
                </div>

                {(selectedNode.outgoingCount != null || selectedNode.belongsToCount != null || selectedNode.relatedToCount != null) && (
                  <div className="grid grid-cols-3 gap-2 text-center text-xs">
                    <div className="rounded-lg border border-border px-2 py-2">
                      <div className="text-muted-foreground">Outgoing</div>
                      <div className="mt-1 text-sm font-semibold">{selectedNode.outgoingCount ?? '—'}</div>
                    </div>
                    <div className="rounded-lg border border-border px-2 py-2">
                      <div className="text-muted-foreground">Belongs</div>
                      <div className="mt-1 text-sm font-semibold">{selectedNode.belongsToCount ?? '—'}</div>
                    </div>
                    <div className="rounded-lg border border-border px-2 py-2">
                      <div className="text-muted-foreground">Related</div>
                      <div className="mt-1 text-sm font-semibold">{selectedNode.relatedToCount ?? '—'}</div>
                    </div>
                  </div>
                )}

                {selectedConnections.length > 0 && (
                  <div>
                    <div className="text-xs uppercase tracking-wide text-muted-foreground">Connections</div>
                    <div className="mt-2 max-h-56 space-y-2 overflow-auto">
                      {selectedConnections.map((connection) => (
                        <button
                          key={`${connection.source}-${connection.target}-${connection.kind}-${connection.label ?? 'nolabel'}`}
                          type="button"
                          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-left text-xs transition-colors hover:bg-accent"
                          onClick={() => connection.peer && setSelectedNodeId(connection.peer.id)}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-semibold text-foreground">{connection.peer?.label}</span>
                            <span className="text-muted-foreground">{connection.direction}</span>
                          </div>
                          <div className="mt-1 text-muted-foreground">
                            {connection.kind}
                            {connection.label ? ` · ${connection.label}` : ''}
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {selectedNode.path && onOpenNote && (
                  <div className="flex gap-2">
                    <button
                      type="button"
                      className="flex-1 rounded-md bg-[var(--primary)] px-3 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90"
                      onClick={() => onOpenNote(selectedNode.path!)}
                    >
                      Open Note
                    </button>
                    <button
                      type="button"
                      className={providerButtonClass(Boolean(pinnedPositions[selectedNode.id]))}
                      onClick={() => setPinnedPositions((current) => {
                        if (current[selectedNode.id]) {
                          const next = { ...current }
                          delete next[selectedNode.id]
                          return next
                        }
                        return {
                          ...current,
                          [selectedNode.id]: { x: selectedNode.x, y: selectedNode.y },
                        }
                      })}
                    >
                      {pinnedPositions[selectedNode.id] ? 'Unpin' : 'Pin'}
                    </button>
                  </div>
                )}

                {provider === 'graphify' && selectedNode.metadata && (
                  <div>
                    <div className="text-xs uppercase tracking-wide text-muted-foreground">Metadata</div>
                    <pre className="mt-2 max-h-56 overflow-auto rounded-lg border border-border bg-background p-2 text-[11px] leading-5 text-muted-foreground">
                      {JSON.stringify(selectedNode.metadata, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            )}
          </aside>
        </div>
      )}
    </div>
  )
}
