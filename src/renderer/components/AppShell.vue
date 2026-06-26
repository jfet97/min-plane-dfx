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
      <span
        class="status-pill"
        v-if="lastPing"
        :title="`Internal IPC health check from renderer to main process at ${lastPing}.`"
      >
        ping: {{ lastPing }}
      </span>
      <span
        class="status-pill"
        v-if="lastPong"
        :title="`Internal IPC health check broadcast from main process at ${lastPong}.`"
      >
        pong: {{ lastPong }}
      </span>
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
  display: grid;
  grid-template-columns: minmax(280px, 1.1fr) minmax(280px, 1fr) minmax(240px, 0.8fr);
  gap: 12px;
  min-height: 0;
  background: var(--bg-panel);
  border-top: 1px solid var(--border);
  padding: 12px;
  overflow: hidden;
}

.status-strip {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  padding: 0 12px;
  background: var(--bg-panel);
  border-top: 1px solid var(--border);
  font-size: 11px;
}
</style>
