<script setup lang="ts">
import type { LauncherState, PrimaryWorkspaceKind } from '~/utils/workspace-state'

type Destination = {
  id: PrimaryWorkspaceKind | 'ask'
  label: string
  description: string
  icon: string
  mnemonic: string
}

const props = defineProps<{
  state: LauncherState
  current: PrimaryWorkspaceKind
  attentionCount: number
  askActive: boolean
  disabled?: boolean
}>()

const emit = defineEmits<{
  compact: []
  expand: []
  close: []
  back: []
  select: [destination: PrimaryWorkspaceKind | 'ask']
}>()

const destinations: readonly Destination[] = [
  {
    id: 'overview',
    label: 'Overview',
    description: 'Current state, result, and review summary',
    icon: 'i-lucide-layout-dashboard',
    mnemonic: 'N',
  },
  {
    id: 'map',
    label: 'Agent map',
    description: 'Explore the session and subagent relationships',
    icon: 'i-lucide-workflow',
    mnemonic: 'M',
  },
  {
    id: 'activity',
    label: 'Activity',
    description: 'Read prompts, tools, and results in order',
    icon: 'i-lucide-activity',
    mnemonic: 'A',
  },
  {
    id: 'changes',
    label: 'Changes',
    description: 'Review file changes and command outcomes',
    icon: 'i-lucide-files',
    mnemonic: 'D',
  },
  {
    id: 'diagnostics',
    label: 'Diagnostics',
    description: 'Investigate data that may affect the result',
    icon: 'i-lucide-stethoscope',
    mnemonic: 'I',
  },
  {
    id: 'ask',
    label: 'Ask',
    description: 'Ask a read-only local agent about the session',
    icon: 'i-lucide-message-square',
    mnemonic: 'Q',
  },
]

const trigger = ref<HTMLButtonElement | null>(null)
const compactMenu = ref<HTMLElement | null>(null)
const expandedNav = ref<HTMLElement | null>(null)
const activeMenuIndex = ref(0)

function currentIndex(): number {
  const index = destinations.findIndex(destination => destination.id === props.current)
  return index < 0 ? 0 : index
}

function focusMenuItem(index: number): void {
  const rows = compactMenu.value?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
  if (!rows?.length) return
  activeMenuIndex.value = (index + rows.length) % rows.length
  rows[activeMenuIndex.value]?.focus()
}

function select(destination: PrimaryWorkspaceKind | 'ask'): void {
  emit('select', destination)
}

function handleCompactKeydown(event: KeyboardEvent): void {
  const rows = compactMenu.value?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
  if (!rows?.length) return
  if (event.key === 'Tab') {
    event.preventDefault()
    focusMenuItem(activeMenuIndex.value + (event.shiftKey ? -1 : 1))
  } else if (event.key === 'ArrowDown') {
    event.preventDefault()
    focusMenuItem(activeMenuIndex.value + 1)
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    focusMenuItem(activeMenuIndex.value - 1)
  } else if (event.key === 'Home') {
    event.preventDefault()
    focusMenuItem(0)
  } else if (event.key === 'End') {
    event.preventDefault()
    focusMenuItem(rows.length - 1)
  } else if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    emit('close')
  } else {
    const destination = destinations.find(item => item.mnemonic.toLowerCase() === event.key.toLowerCase())
    if (!destination) return
    event.preventDefault()
    select(destination.id)
  }
}

function handleExpandedKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    emit('back')
    return
  }
  const destination = destinations.find(item => item.mnemonic.toLowerCase() === event.key.toLowerCase())
  if (!destination) return
  event.preventDefault()
  select(destination.id)
}

function restoreTriggerFocus(): void {
  nextTick(() => trigger.value?.focus())
}

watch(
  () => props.state.kind,
  (kind, previous) => {
    if (kind === 'compact') {
      activeMenuIndex.value = currentIndex()
      nextTick(() => focusMenuItem(activeMenuIndex.value))
    } else if (kind === 'expanded') {
      nextTick(() => {
        const selector = `[data-destination="${props.current}"]`
        expandedNav.value?.querySelector<HTMLButtonElement>(selector)?.focus()
      })
    } else if (previous !== 'closed') {
      restoreTriggerFocus()
    }
  },
)

defineExpose({ focusTrigger: restoreTriggerFocus })
</script>

<template>
  <div class="open-view-launcher" :class="`launcher-${state.kind}`">
    <button
      v-if="state.kind !== 'expanded'"
      ref="trigger"
      type="button"
      class="open-view-trigger"
      :disabled="disabled"
      aria-haspopup="menu"
      :aria-expanded="state.kind === 'compact'"
      aria-controls="open-view-menu"
      aria-label="Open a session view"
      @click="state.kind === 'compact' ? emit('close') : emit('compact')"
    >
      <UIcon name="i-lucide-panels-top-left" />
      <span>Open view</span>
    </button>

    <div
      v-if="state.kind === 'compact'"
      id="open-view-menu"
      ref="compactMenu"
      class="compact-launcher"
      role="menu"
      aria-label="Open a session view"
      @keydown="handleCompactKeydown"
    >
      <button
        v-for="(destination, index) in destinations"
        :key="destination.id"
        type="button"
        role="menuitem"
        :tabindex="index === activeMenuIndex ? 0 : -1"
        :aria-current="destination.id === current ? 'page' : undefined"
        :data-destination="destination.id"
        @focus="activeMenuIndex = index"
        @click="select(destination.id)"
      >
        <UIcon :name="destination.icon" />
        <span>{{ destination.label }}</span>
        <span
          v-if="destination.id === 'diagnostics' && attentionCount"
          class="launcher-attention"
          :aria-label="`${attentionCount} warning or error ${attentionCount === 1 ? 'incident' : 'incidents'}`"
        >{{ attentionCount }}</span>
        <span v-else-if="destination.id === 'ask' && askActive" class="launcher-active" aria-label="Ask conversation active" />
        <kbd>{{ destination.mnemonic }}</kbd>
      </button>
      <button type="button" role="menuitem" :tabindex="activeMenuIndex === destinations.length ? 0 : -1" @focus="activeMenuIndex = destinations.length" @click="emit('expand')">
        <UIcon name="i-lucide-expand" />
        <span>Expand launcher</span>
        <UIcon name="i-lucide-arrow-up-right" />
      </button>
    </div>

    <section
      v-if="state.kind === 'expanded'"
      class="expanded-launcher"
      @keydown="handleExpandedKeydown"
    >
      <button type="button" class="launcher-back" @click="emit('back')">
        <UIcon name="i-lucide-arrow-left" /> Back to view
      </button>
      <nav ref="expandedNav" aria-labelledby="open-view-heading">
        <header>
          <span class="section-eyebrow">Session workspace</span>
          <h1 id="open-view-heading">Open a session view</h1>
          <p>Choose what you want to inspect.</p>
        </header>
        <div class="expanded-launcher-list">
          <button
            v-for="destination in destinations"
            :key="destination.id"
            type="button"
            :data-destination="destination.id"
            :aria-current="destination.id === current ? 'page' : undefined"
            @click="select(destination.id)"
          >
            <UIcon :name="destination.icon" />
            <span>
              <strong>{{ destination.label }}</strong>
              <small>{{ destination.description }}</small>
            </span>
            <span
              v-if="destination.id === 'diagnostics' && attentionCount"
              class="expanded-attention"
            >{{ attentionCount }} {{ attentionCount === 1 ? 'incident' : 'incidents' }}</span>
            <span v-else-if="destination.id === 'ask' && askActive" class="expanded-attention active">Active</span>
            <kbd>{{ destination.mnemonic }}</kbd>
          </button>
        </div>
      </nav>
    </section>
  </div>
</template>
