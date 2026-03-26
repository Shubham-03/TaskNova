/**
 * TaskNova — sync.js
 * Offline-first sync: IndexedDB (primary) ↔ Supabase (cloud backup)
 *
 * HOW TO ACTIVATE CLOUD SYNC
 * ───────────────────────────
 * 1. Create a free project at https://supabase.com
 * 2. Run the SQL in the README / implementation_plan to create the `tasks` table.
 * 3. Replace SUPABASE_URL and SUPABASE_ANON_KEY below with your project values.
 *    (Settings → API in the Supabase dashboard)
 */

/* ─────────────────────────────────────────────
   SUPABASE CONFIGURATION  ← edit these two lines
   ───────────────────────────────────────────── */
const SUPABASE_URL = 'https://wmkxgmgkhnsrnbrlgpkl.supabase.co';   // ← replace
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indta3hnbWdraG5zcm5icmxncGtsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ1NDEzNzgsImV4cCI6MjA5MDExNzM3OH0.X8zvYt4eFmuGhcC21wWG5Hm2AB5jIEeVKcfrGsGCFQ0';               // ← replace
const SUPABASE_TABLE = 'tasks';

/** Returns true when real Supabase credentials have been provided. */
const supabaseConfigured = () =>
    !SUPABASE_URL.includes('YOUR_PROJECT') &&
    !SUPABASE_ANON_KEY.includes('YOUR_ANON');

/* ═══════════════════════════════════════════════════════════════
   DB  — thin IndexedDB wrapper
   Every method returns a Promise.
   ═══════════════════════════════════════════════════════════════ */
const DB = (() => {
    const DB_NAME = 'tasknova';
    const DB_VERSION = 1;
    const STORE = 'tasks';
    let _db = null;       // cached IDBDatabase reference

    /** Opens (or upgrades) the database. Call once at app start. */
    function open() {
        return new Promise((resolve, reject) => {
            if (_db) { resolve(_db); return; }

            const req = indexedDB.open(DB_NAME, DB_VERSION);

            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(STORE)) {
                    const store = db.createObjectStore(STORE, { keyPath: 'id' });
                    store.createIndex('updatedAt', 'updatedAt', { unique: false });
                    store.createIndex('synced', 'synced', { unique: false });
                }
            };

            req.onsuccess = (e) => { _db = e.target.result; resolve(_db); };
            req.onerror = (e) => reject(e.target.error);
        });
    }

    /** Returns all task objects from the store. */
    function getAll() {
        return new Promise((resolve, reject) => {
            const tx = _db.transaction(STORE, 'readonly');
            const req = tx.objectStore(STORE).getAll();
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    /** Get a single task by id. */
    function get(id) {
        return new Promise((resolve, reject) => {
            const tx = _db.transaction(STORE, 'readonly');
            const req = tx.objectStore(STORE).get(id);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    /** Upsert a single task. */
    function put(task) {
        return new Promise((resolve, reject) => {
            const tx = _db.transaction(STORE, 'readwrite');
            const req = tx.objectStore(STORE).put(task);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    /** Batch upsert an array of tasks (single transaction). */
    function bulkPut(tasks) {
        return new Promise((resolve, reject) => {
            const tx = _db.transaction(STORE, 'readwrite');
            const store = tx.objectStore(STORE);
            tasks.forEach(t => store.put(t));
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    /** Hard-delete a task from IDB by id. */
    function remove(id) {
        return new Promise((resolve, reject) => {
            const tx = _db.transaction(STORE, 'readwrite');
            const req = tx.objectStore(STORE).delete(id);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });
    }

    return { open, getAll, get, put, bulkPut, remove };
})();

/* ═══════════════════════════════════════════════════════════════
   SyncManager  — handles online/offline detection, push & pull
   ═══════════════════════════════════════════════════════════════ */
const SyncManager = (() => {

    let _retryTimer = null;
    let _isSyncing = false;
    const RETRY_MS = 30_000;   // retry every 30 s after a failure

    /* ── Supabase REST helpers ─────────────────────────────────── */

    function _headers() {
        return {
            'Content-Type': 'application/json',
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
            'Prefer': 'resolution=merge-duplicates',
        };
    }

    /**
     * Upsert tasks to Supabase.
     * Uses POST with "resolution=merge-duplicates" (upsert on primary key).
     */
    async function _upsertRemote(tasks) {
        if (!tasks.length) return;
        // Map IDB field names to Supabase column names
        const rows = tasks.map(t => ({
            id: t.id,
            title: t.title,
            description: t.desc || '',
            status: t.status,
            priority: t.priority,
            deadline: t.deadline || null,
            tags: t.tags || [],
            workspace: t.workspace,
            pinned: t.pinned,
            completed: t.completed,
            deleted: t.deleted || false,
            updated_at: t.updatedAt,
        }));

        const res = await fetch(
            `${SUPABASE_URL}/rest/v1/${SUPABASE_TABLE}`,
            { method: 'POST', headers: _headers(), body: JSON.stringify(rows) }
        );
        if (!res.ok) throw new Error(`Supabase upsert failed: ${res.status} ${res.statusText}`);
    }

    /** Fetch all (non-deleted) tasks from Supabase. */
    async function _fetchRemote() {
        const res = await fetch(
            `${SUPABASE_URL}/rest/v1/${SUPABASE_TABLE}?select=*`,
            { method: 'GET', headers: _headers() }
        );
        if (!res.ok) throw new Error(`Supabase fetch failed: ${res.status} ${res.statusText}`);
        return res.json();
    }

    /* ── Sync UI ───────────────────────────────────────────────── */

    /**
     * status: 'online' | 'offline' | 'syncing' | 'error'
     */
    function updateSyncUI(status) {
        const pill = document.getElementById('sync-status');
        const dot = document.getElementById('sync-dot');
        const label = document.getElementById('sync-label');
        if (!pill) return;

        // Remove all state classes
        pill.classList.remove('sync-online', 'sync-offline', 'sync-syncing', 'sync-error');

        switch (status) {
            case 'online':
                pill.classList.add('sync-online');
                dot.className = 'sync-dot';
                label.textContent = 'Online';
                break;
            case 'offline':
                pill.classList.add('sync-offline');
                dot.className = 'sync-dot';
                label.textContent = 'Offline';
                break;
            case 'syncing':
                pill.classList.add('sync-syncing');
                dot.className = 'sync-dot sync-spin';
                label.textContent = 'Syncing…';
                break;
            case 'error':
                pill.classList.add('sync-error');
                dot.className = 'sync-dot';
                label.textContent = 'Sync Error';
                break;
        }
    }

    /* ── Push: local → Supabase ────────────────────────────────── */

    async function pushToSupabase() {
        const allTasks = await DB.getAll();
        const unsynced = allTasks.filter(t => t.synced === false);
        if (!unsynced.length) return;

        await _upsertRemote(unsynced);

        // Mark them as synced in IDB
        const now = new Date().toISOString();
        await DB.bulkPut(unsynced.map(t => ({ ...t, synced: true })));
        console.log(`[SyncManager] Pushed ${unsynced.length} task(s) to Supabase`);
    }

    /* ── Pull: Supabase → local ────────────────────────────────── */

    async function pullFromSupabase() {
        const remoteTasks = await _fetchRemote();
        if (!remoteTasks.length) return;

        const toWrite = [];

        for (const remote of remoteTasks) {
            // Map Supabase column names → IDB field names
            const remoteTask = {
                id: remote.id,
                title: remote.title,
                desc: remote.description || '',
                status: remote.status,
                priority: remote.priority,
                deadline: remote.deadline || '',
                tags: remote.tags || [],
                workspace: remote.workspace,
                pinned: remote.pinned,
                completed: remote.completed,
                deleted: remote.deleted,
                createdAt: remote.created_at,
                updatedAt: remote.updated_at,
                synced: true,   // just came from the cloud
            };

            const local = await DB.get(remote.id);

            if (!local) {
                // Brand new from cloud — add it (unless deleted)
                if (!remoteTask.deleted) toWrite.push(remoteTask);
            } else {
                // Conflict resolution: last-updated-wins
                const remoteTime = new Date(remote.updated_at).getTime();
                const localTime = new Date(local.updatedAt).getTime();

                if (remoteTime > localTime) {
                    // Remote is newer — overwrite local
                    toWrite.push(remoteTask);
                }
                // else: local is newer, push will handle it on next cycle
            }
        }

        if (toWrite.length) {
            // Remove hard-deleted tasks from IDB
            const toDelete = toWrite.filter(t => t.deleted);
            const toSave = toWrite.filter(t => !t.deleted);

            for (const t of toDelete) await DB.remove(t.id);
            if (toSave.length) await DB.bulkPut(toSave);

            console.log(`[SyncManager] Pulled ${toSave.length} task(s) from Supabase, removed ${toDelete.length}`);

            // Notify the app to re-render if it's already initialised
            if (window.App && typeof window.App.reloadFromIDB === 'function') {
                await window.App.reloadFromIDB();
            }
        }
    }

    /* ── Full sync (push then pull) ────────────────────────────── */

    async function fullSync() {
        if (_isSyncing) return;
        if (!navigator.onLine) { updateSyncUI('offline'); return; }
        if (!supabaseConfigured()) {
            // Credentials not set — show online but skip cloud sync silently
            updateSyncUI('online');
            return;
        }

        _isSyncing = true;
        clearTimeout(_retryTimer);
        updateSyncUI('syncing');

        try {
            await pushToSupabase();
            await pullFromSupabase();
            updateSyncUI('online');
            console.log('[SyncManager] Full sync complete');
        } catch (err) {
            console.error('[SyncManager] Sync failed:', err);
            updateSyncUI('error');
            // Retry after RETRY_MS
            _retryTimer = setTimeout(() => {
                console.log('[SyncManager] Retrying sync…');
                fullSync();
            }, RETRY_MS);
        } finally {
            _isSyncing = false;
        }
    }

    /** Call after any local write to kick off a sync (debounced by 1 s). */
    let _syncDebounce = null;
    function triggerSync() {
        clearTimeout(_syncDebounce);
        _syncDebounce = setTimeout(fullSync, 1000);
    }

    /* ── Initialise ────────────────────────────────────────────── */

    async function init() {
        await DB.open();

        // Reflect initial connectivity
        updateSyncUI(navigator.onLine ? 'online' : 'offline');

        window.addEventListener('online', () => {
            console.log('[SyncManager] Back online — syncing…');
            fullSync();
        });

        window.addEventListener('offline', () => {
            console.log('[SyncManager] Gone offline');
            updateSyncUI('offline');
            clearTimeout(_retryTimer);
        });

        // Initial sync on page load
        if (navigator.onLine) fullSync();
    }

    return { init, triggerSync, fullSync, updateSyncUI };
})();
