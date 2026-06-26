<script setup lang="ts">
defineProps<{
  readonly lastPing: string | null
  readonly lastPingLabel?: string
  readonly lastPong: string | null
}>()
</script>

<template>
  <div class="shell">
    <header class="toolbar">
      <span class="brand">Min Plane DXF</span>
      <slot name="toolbar" />
      <span class="spacer" />
      <span class="status-pill" v-if="lastPing" :title="`ping at ${lastPing}`">ping: {{ lastPing }}</span>
      <span class="status-pill" v-if="lastPong" :title="`pong at ${lastPong}`">pong: {{ lastPong }}</span>
    </header>

    <main class="workspace">
      <aside class="panel left">
        <slot name="settings" />
      </aside>
      <section class="panel center">
        <slot name="canvas" />
      </section>
      <aside class="panel right">
        <slot name="pieces" />
      </aside>
    </main>

    <footer class="timeline">
      <slot name="timeline" />
    </footer>

    <div class="status-strip">
      <slot name="status" />
    </div>
  </div>
</template>

<style scoped>
.shell {
  display: grid;
  grid-template-rows: var(--toolbar-height) 1fr var(--timeline-height) var(--status-height);
  height: 100%;
  background: var(--bg-app);
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 12px;
  background: var(--bg-panel);
  border-bottom: 1px solid var(--border);
}

.brand {
  font-weight: 600;
  margin-right: 12px;
}

.spacer {
  flex: 1;
}

.status-pill {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-secondary);
  background: var(--bg-elevated);
  padding: 2px 8px;
  border-radius: var(--radius);
}

.workspace {
  display: grid;
  grid-template-columns: 280px 1fr 320px;
  gap: 1px;
  background: var(--border);
  overflow: hidden;
}

.panel {
  background: var(--bg-panel);
  padding: 12px;
  overflow: auto;
}

.timeline {
  background: var(--bg-panel);
  border-top: 1px solid var(--border);
  padding: 12px;
}

.status-strip {
  display: flex;
  align-items: center;
  padding: 0 12px;
  background: var(--bg-panel);
  border-top: 1px solid var(--border);
  font-size: 11px;
}
</style>