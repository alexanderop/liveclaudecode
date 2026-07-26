<script setup lang="ts">
import type { RunResponse } from '#shared/types/run'

const props = defineProps<{ run: RunResponse | null }>()

const successfulCommands = computed(() => props.run?.node.commands.filter(command => command.ok === true).length || 0)
const failedCommands = computed(() => props.run?.node.commands.filter(command => command.ok === false).length || 0)
const patchChanges = computed(() => [...(props.run?.diagnostics.changes || [])].reverse())
const gitEvents = computed(() => [...(props.run?.diagnostics.git || [])].reverse())
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
          <p>Concrete artifacts produced by the session, separated from its conversational activity.</p>
        </div>
        <div class="change-totals">
          <div><strong>{{ run.files.length }}</strong><span>Files</span></div>
          <div><strong>{{ run.node.commands.length }}</strong><span>Commands</span></div>
          <div class="success"><strong>{{ successfulCommands }}</strong><span>Passed</span></div>
          <div :class="{ failure: failedCommands }"><strong>{{ failedCommands }}</strong><span>Failed</span></div>
        </div>
      </section>

      <div class="changes-columns">
        <section class="content-section file-section">
          <div class="section-heading">
            <div>
              <h3>Files changed</h3>
              <p>Across the entire session and its subagents</p>
            </div>
            <span class="section-count">{{ run.files.length }}</span>
          </div>
          <div v-if="run.files.length" class="artifact-list">
            <div v-for="[path, operations] in run.files" :key="path" class="artifact-row">
              <span class="artifact-icon changed"><UIcon name="i-lucide-file-pen-line" /></span>
              <span class="artifact-copy">
                <strong :title="path">{{ path.split('/').at(-1) }}</strong>
                <small :title="path">{{ path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : 'Repository root' }}</small>
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
              <p>Validation and repository operations from this agent</p>
            </div>
            <span class="section-count">{{ run.node.commands.length }}</span>
          </div>
          <div v-if="run.node.commands.length" class="command-list">
            <div v-for="command in [...run.node.commands].reverse()" :key="command.tid" class="command-row">
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
            <div><h3>Git outcomes</h3><p>Commits, pushes, branches, and pull requests detected by Claude</p></div>
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
