<script setup lang="ts">
import type { RunNode, RunResponse } from '#shared/types/run'
import { flattenRunTree } from '~/utils/execution-analysis'
import { splitPath } from '~/utils/file-changes'

const props = defineProps<{ run: RunResponse | null, root?: RunNode | null, selectedKey?: string | null }>()
const scope = ref<'session' | 'agent'>('session')

const sessionNodes = computed(() => {
  const nodes = flattenRunTree(props.root || null)
  return nodes.length ? nodes : props.run?.node ? [props.run.node] : []
})
const selectedNode = computed(() => sessionNodes.value.find(node => node.key === (props.selectedKey || props.run?.node.key)) || props.run?.node || null)
const commands = computed(() => scope.value === 'session'
  ? sessionNodes.value.flatMap(node => node.commands)
  : selectedNode.value?.commands || [])
const files = computed<Array<[string, number]>>(() => scope.value === 'session'
  ? props.run?.files || []
  : (selectedNode.value?.files || []).map(file => [file.path, file.ops]))
const successfulCommands = computed(() => commands.value.filter(command => command.ok === true).length)
const failedCommands = computed(() => commands.value.filter(command => command.ok === false).length)
const patchChanges = computed(() => [...(props.run?.diagnostics.changes || [])]
  .filter(change => scope.value === 'session' || change.key === selectedNode.value?.key)
  .reverse())
const gitEvents = computed(() => [...(props.run?.diagnostics.git || [])]
  .filter(event => scope.value === 'session' || event.key === selectedNode.value?.key)
  .reverse())
const scopeLabel = computed(() => scope.value === 'session' ? 'Whole session' : 'Selected agent')
</script>

<template>
  <div class="changes-view">
    <div v-if="!run" class="empty-state">
      <span class="empty-state-icon"><UIcon name="i-lucide-files" /></span>
      <h2>No changes to show</h2>
      <p>Select a session to inspect its files and commands.</p>
    </div>

    <template v-else>
      <section class="changes-summary">
        <div>
          <span class="section-eyebrow">Session output</span>
          <h2>Changes and validation</h2>
          <p>Concrete artifacts and validation outcomes scoped consistently to {{ scopeLabel.toLowerCase() }}.</p>
        </div>
        <div class="segments change-scope" role="group" aria-label="Changes scope">
          <button type="button" :class="{ selected: scope === 'session' }" :aria-pressed="scope === 'session'" @click="scope = 'session'">Whole session</button>
          <button type="button" :class="{ selected: scope === 'agent' }" :aria-pressed="scope === 'agent'" @click="scope = 'agent'">Selected agent</button>
        </div>
        <div class="change-totals">
          <div><strong>{{ files.length }}</strong><span>Files</span></div>
          <div><strong>{{ commands.length }}</strong><span>Commands</span></div>
          <div class="success"><strong>{{ successfulCommands }}</strong><span>Passed</span></div>
          <div :class="{ failure: failedCommands }"><strong>{{ failedCommands }}</strong><span>Failed</span></div>
        </div>
      </section>

      <div class="changes-columns">
        <section class="content-section file-section">
          <div class="section-heading">
            <div>
              <h3>Files changed</h3>
              <p>{{ scopeLabel }}</p>
            </div>
            <span class="section-count">{{ files.length }}</span>
          </div>
          <div v-if="files.length" class="artifact-list">
            <div v-for="[path, operations] in files" :key="path" class="artifact-row">
              <span class="artifact-icon changed"><UIcon name="i-lucide-file-pen-line" /></span>
              <span class="artifact-copy">
                <strong :title="path">{{ splitPath(path).name }}</strong>
                <small :title="path">{{ splitPath(path).directory }}</small>
              </span>
              <span class="operation-count">{{ operations }} {{ operations === 1 ? 'edit' : 'edits' }}</span>
            </div>
          </div>
          <p v-else class="empty-note">This session has not written any files.</p>
        </section>

        <section class="content-section command-section">
          <div class="section-heading">
            <div>
              <h3>Commands</h3>
              <p>{{ scopeLabel }}</p>
            </div>
            <span class="section-count">{{ commands.length }}</span>
          </div>
          <div v-if="commands.length" class="command-list">
            <div v-for="command in [...commands].reverse()" :key="`${command.tid}-${command.ts}`" class="command-row">
              <span class="command-state" :class="command.ok === null ? 'pending' : command.ok ? 'ok' : 'failed'">
                <UIcon :name="command.ok === null ? 'i-lucide-loader-circle' : command.ok ? 'i-lucide-check' : 'i-lucide-x'" />
              </span>
              <code :title="command.cmd">{{ command.cmd }}</code>
              <time>{{ formatTime(command.ts, false) }}</time>
            </div>
          </div>
          <p v-else class="empty-note">No commands were recorded for this agent.</p>
        </section>
      </div>

      <div v-if="patchChanges.length || gitEvents.length" class="changes-columns provenance-columns">
        <section class="content-section file-section">
          <div class="section-heading">
            <div><h3>Patch provenance</h3><p>Structured line changes linked to the responsible agent</p></div>
            <span class="section-count">{{ patchChanges.length }}</span>
          </div>
          <div v-if="patchChanges.length" class="patch-list">
            <div v-for="change in patchChanges" :key="`${change.toolUseId}-${change.path}`" class="patch-row">
              <span class="artifact-icon changed"><UIcon name="i-lucide-file-diff" /></span>
              <span class="artifact-copy">
                <strong :title="change.path">{{ change.path }}</strong>
                <small>{{ change.who }} · {{ change.tool }} · {{ formatTime(change.ts, false) }}</small>
              </span>
              <span class="patch-lines"><b>+{{ change.linesAdded }}</b><i>-{{ change.linesRemoved }}</i></span>
              <span v-if="change.staleRecovered" class="patch-warning">stale edit recovered</span>
            </div>
          </div>
          <p v-else class="empty-note">No structured patch metadata was recorded.</p>
        </section>

        <section class="content-section command-section">
          <div class="section-heading">
            <div><h3>Git outcomes</h3><p>Commits, pushes, branches, and pull requests detected in the session</p></div>
            <span class="section-count">{{ gitEvents.length }}</span>
          </div>
          <div v-if="gitEvents.length" class="git-event-list">
            <div v-for="event in gitEvents" :key="`${event.toolUseId}-${event.kind}-${event.ts}`" class="git-event-row">
              <span class="command-state ok"><UIcon :name="event.kind === 'pr' ? 'i-lucide-git-pull-request' : event.kind === 'commit' ? 'i-lucide-git-commit-horizontal' : event.kind === 'push' ? 'i-lucide-cloud-upload' : 'i-lucide-git-branch'" /></span>
              <span><strong>{{ event.label }}</strong><small>{{ event.who }} · {{ formatTime(event.ts, false) }}</small></span>
              <a v-if="event.url" :href="event.url" target="_blank" rel="noopener noreferrer">Open</a>
            </div>
          </div>
          <p v-else class="empty-note">No structured Git outcomes were recorded.</p>
        </section>
      </div>
    </template>
  </div>
</template>
