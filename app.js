/**
 * TaskNova - Core Application Logic
 * Offline-first: IndexedDB is the primary store; Supabase is synced via sync.js
 */

const App = {
    // 1. State Management
    state: {
        tasks: [],
        workspace: 'personal', // 'personal' or 'work'
        gamification: {
            points: 0,
            streak: 0,
            lastLoginDate: null,
            tasksCompleted: 0
        },
        editingTaskId: null,
        taskToDeleteId: null,
        // Focus Mode State
        focusTask: null,
        focusTimer: null,
        timeLeft: 25 * 60, // 25 mins
        isTimerRunning: false,
    },

    // 2. Initialization (async — waits for IDB to be ready)
    async init() {
        // SyncManager.init() opens IDB; we must await it before any IDB reads
        await SyncManager.init();
        await this.loadState();
        this.cacheDOM();
        this.bindEvents();
        this.initTheme();
        this.initSortable();
        this.updateStreak();
        this.initViews();
        this.renderAll();
    },

    // ── Load state from IndexedDB (primary) ──────────────────────
    async loadState() {
        // One-time migration: if localStorage has tasks, import them to IDB
        const lsRaw = localStorage.getItem('tasknova_tasks');
        if (lsRaw) {
            try {
                const lsTasks = JSON.parse(lsRaw);
                const now = new Date().toISOString();
                const migrated = lsTasks.map(t => ({
                    ...t,
                    updatedAt: t.updatedAt || t.createdAt || now,
                    synced: false,
                    deleted: t.deleted || false,
                }));
                await DB.bulkPut(migrated);
                localStorage.removeItem('tasknova_tasks');
                console.log('[App] Migrated tasks from localStorage → IndexedDB');
            } catch (e) {
                console.warn('[App] Migration from localStorage failed:', e);
            }
        }

        // Read all tasks from IDB (exclude soft-deleted)
        const allTasks = await DB.getAll();
        this.state.tasks = allTasks.filter(t => !t.deleted);

        // First-run demo data
        if (!this.state.tasks.length) {
            const demoTask = {
                id: 't1',
                title: 'Welcome to TaskNova! 👋',
                desc: 'Drag me to "In Progress" to try it out.',
                status: 'todo',
                priority: 'high',
                deadline: this.getTodayDate(),
                tags: ['Onboarding'],
                workspace: 'personal',
                pinned: true,
                completed: false,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                synced: false,
                deleted: false,
            };
            await DB.put(demoTask);
            this.state.tasks = [demoTask];
        }

        // Gamification & workspace from localStorage (small, no sync needed)
        const savedGami      = localStorage.getItem('tasknova_gami');
        const savedWorkspace = localStorage.getItem('tasknova_workspace');
        if (savedGami)      this.state.gamification = JSON.parse(savedGami);
        if (savedWorkspace) this.state.workspace    = savedWorkspace;
    },

    // ── Reload tasks from IDB (called by SyncManager after a pull) ──
    async reloadFromIDB() {
        const allTasks    = await DB.getAll();
        this.state.tasks  = allTasks.filter(t => !t.deleted);
        this.renderBoard();
        this.renderDashboard();
    },

    // ── Persist a single task to IDB + trigger sync ───────────────
    async _saveTask(task) {
        const now = new Date().toISOString();
        const updated = { ...task, updatedAt: now, synced: false };
        // Update in-memory reference too
        const idx = this.state.tasks.findIndex(t => t.id === updated.id);
        if (idx !== -1) this.state.tasks[idx] = updated;
        await DB.put(updated);
        SyncManager.triggerSync();
        return updated;
    },

    // ── Legacy-compat stub (some internal callers still use saveTasks)
    async saveTasks() {
        // Batch-write all in-memory tasks to IDB and mark unsynced
        const now = new Date().toISOString();
        const tasks = this.state.tasks.map(t => ({
            ...t,
            updatedAt: t.updatedAt || now,
            synced:    false,
            deleted:   t.deleted || false,
        }));
        await DB.bulkPut(tasks);
        SyncManager.triggerSync();
    },

    saveGami() {
        localStorage.setItem('tasknova_gami', JSON.stringify(this.state.gamification));
    },

    getTodayDate() {
        return new Date().toISOString().split('T')[0];
    },

    cacheDOM() {
        this.dom = {
            // Sidebar nav items (desktop)
            navItems: document.querySelectorAll('[data-view]'),
            views: document.querySelectorAll('.view-section'),
            workspaceSelect: document.getElementById('workspace-select'),
            workspaceSelectMobile: document.getElementById('workspace-select-mobile'),
            themeToggle: document.getElementById('theme-toggle'),
            searchInput: document.getElementById('search-input'),

            // Sidebar + hamburger
            sidebar: document.getElementById('sidebar'),
            hamburger: document.getElementById('hamburger-btn'),
            overlay: document.getElementById('mobile-nav-overlay'),

            // Columns
            cols: {
                todo: document.getElementById('col-todo'),
                inprogress: document.getElementById('col-inprogress'),
                done: document.getElementById('col-done')
            },
            counts: {
                todo: document.getElementById('count-todo'),
                inprogress: document.getElementById('count-inprogress'),
                done: document.getElementById('count-done')
            },

            // Modal
            modal: document.getElementById('task-modal'),
            modalTitle: document.getElementById('modal-title'),
            taskForm: document.getElementById('task-form'),
            taskTitle: document.getElementById('task-title-input'),
            taskDesc: document.getElementById('task-desc-input'),
            taskPriority: document.getElementById('task-priority-input'),
            taskDate: document.getElementById('task-date-input'),
            taskTags: document.getElementById('task-tags-input'),
            btnNewTask: document.getElementById('new-task-btn'),
            btnNewTaskMobile: document.getElementById('mobile-new-task-btn'),
            btnModalClose: document.getElementById('close-modal-btn'),
            btnModalCancel: document.getElementById('cancel-modal-btn'),

            // Delete Modal
            deleteModal: document.getElementById('delete-modal'),
            btnConfirmDelete: document.getElementById('confirm-delete-btn'),
            btnCancelDelete: document.getElementById('cancel-delete-btn'),

            // Gamification
            wlLevel: document.getElementById('user-level'),
            wlStreak: document.getElementById('user-streak'),
            wlProgress: document.getElementById('level-progress'),
            wlPoints: document.getElementById('user-points'),

            // Dashboard
            dashCompleted: document.getElementById('dash-completed'),
            dashStreak: document.getElementById('dash-streak-big'),
            dashPoints: document.getElementById('dash-points-big'),

            // Focus Mode
            focusTitle: document.getElementById('focus-task-title'),
            focusTime: document.getElementById('focus-time'),
            focusCircle: document.getElementById('focus-circle'),
            focusStartBtn: document.getElementById('focus-start-btn'),
            focusResetBtn: document.getElementById('focus-reset-btn'),
        };

        // Sync workspace selects
        if (this.dom.workspaceSelect) this.dom.workspaceSelect.value = this.state.workspace;
        if (this.dom.workspaceSelectMobile) this.dom.workspaceSelectMobile.value = this.state.workspace;
    },

    // 4. Event Listeners
    bindEvents() {
        // ---- All nav items (sidebar + bottom nav) ----
        document.querySelectorAll('[data-view]').forEach(item => {
            item.addEventListener('click', (e) => {
                e.preventDefault();
                const view = item.dataset.view;
                this.switchView(view);
                this.closeMobileSidebar();
            });
        });

        // ---- Hamburger: open mobile sidebar ----
        if (this.dom.hamburger) {
            this.dom.hamburger.addEventListener('click', () => this.toggleMobileSidebar());
        }
        if (this.dom.overlay) {
            this.dom.overlay.addEventListener('click', () => this.closeMobileSidebar());
        }

        // ---- Theme ----
        this.dom.themeToggle.addEventListener('click', () => this.toggleTheme());

        // ---- Workspace (header + mobile) ----
        const onWorkspaceChange = (e) => {
            this.state.workspace = e.target.value;
            localStorage.setItem('tasknova_workspace', this.state.workspace);
            if (this.dom.workspaceSelect) this.dom.workspaceSelect.value = this.state.workspace;
            if (this.dom.workspaceSelectMobile) this.dom.workspaceSelectMobile.value = this.state.workspace;
            this.renderAll();
        };
        if (this.dom.workspaceSelect) this.dom.workspaceSelect.addEventListener('change', onWorkspaceChange);
        if (this.dom.workspaceSelectMobile) this.dom.workspaceSelectMobile.addEventListener('change', onWorkspaceChange);

        // ---- Search ----
        this.dom.searchInput.addEventListener('input', (e) => this.renderBoard(e.target.value));

        // ---- New Task buttons ----
        this.dom.btnNewTask.addEventListener('click', () => this.openModal());
        if (this.dom.btnNewTaskMobile) {
            this.dom.btnNewTaskMobile.addEventListener('click', () => this.openModal());
        }
        this.dom.btnModalClose.addEventListener('click', () => this.closeModal());
        this.dom.btnModalCancel.addEventListener('click', () => this.closeModal());
        this.dom.modal.addEventListener('click', (e) => {
            if (e.target === this.dom.modal) this.closeModal();
        });

        // ---- Delete Modal ----
        this.dom.btnCancelDelete.addEventListener('click', () => this.closeDeleteModal());
        this.dom.deleteModal.addEventListener('click', (e) => {
            if (e.target === this.dom.deleteModal) this.closeDeleteModal();
        });
        this.dom.btnConfirmDelete.addEventListener('click', () => {
            if (this.state.taskToDeleteId) {
                this.executeDeleteTask(this.state.taskToDeleteId);
            }
        });

        // ---- Task Form ----
        this.dom.taskForm.addEventListener('submit', (e) => {
            e.preventDefault();
            this.saveTaskFromForm();
        });

        // ---- Board delegation ----
        Object.values(this.dom.cols).forEach(col => {
            col.addEventListener('click', (e) => {
                const btn = e.target.closest('button');
                if (!btn) return;
                const card = btn.closest('.task-card');
                if (!card) return;
                const id = card.dataset.id;
                if (btn.classList.contains('action-delete')) this.deleteTask(id);
                if (btn.classList.contains('action-edit'))   this.editTask(id);
                if (btn.classList.contains('action-pin'))    this.togglePin(id);
                if (btn.classList.contains('action-focus'))  this.setFocusTask(id);
            });
            col.addEventListener('change', (e) => {
                if (e.target.classList.contains('task-checkbox')) {
                    const id = e.target.closest('.task-card').dataset.id;
                    this.toggleTaskCompletion(id, e.target.checked);
                }
            });
        });

        // ---- Focus Mode ----
        this.dom.focusStartBtn.addEventListener('click', () => this.toggleFocusTimer());
        this.dom.focusResetBtn.addEventListener('click', () => this.resetFocusTimer());
    },

    // Mobile sidebar helpers
    toggleMobileSidebar() {
        if (this.dom.sidebar) this.dom.sidebar.classList.toggle('mobile-open');
        if (this.dom.overlay) this.dom.overlay.classList.toggle('active');
    },
    closeMobileSidebar() {
        if (this.dom.sidebar) this.dom.sidebar.classList.remove('mobile-open');
        if (this.dom.overlay) this.dom.overlay.classList.remove('active');
    },

    // 5. Theme
    initTheme() {
        if (localStorage.theme === 'dark' || (!('theme' in localStorage) && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
            document.documentElement.classList.add('dark');
        } else {
            document.documentElement.classList.remove('dark');
        }
        this.syncThemeIcon();
    },

    syncThemeIcon() {
        const icon = document.getElementById('theme-icon');
        if (!icon) return;
        const isDark = document.documentElement.classList.contains('dark');
        icon.className = isDark
            ? 'fa-solid fa-sun text-yellow-400'
            : 'fa-solid fa-moon text-slate-600';
    },

    toggleTheme() {
        document.documentElement.classList.toggle('dark');
        localStorage.setItem('theme', document.documentElement.classList.contains('dark') ? 'dark' : 'light');
        this.syncThemeIcon();
    },

    // Initialize all views hidden, then show the default (board)
    initViews() {
        const viewMap = {
            'view-board':     'flex',
            'view-dashboard': 'block',
            'view-focus':     'flex',
        };
        Object.keys(viewMap).forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.display = 'none';
        });
        const board = document.getElementById('view-board');
        if (board) board.style.display = 'flex';
        this._activeViewDisplay = viewMap;
    },

    switchView(viewName) {
        const viewIds = ['view-board', 'view-dashboard', 'view-focus'];
        viewIds.forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.display = 'none';
        });
        const displayMap = { board: 'flex', dashboard: 'block', focus: 'flex' };
        const target = document.getElementById(`view-${viewName}`);
        if (target) target.style.display = displayMap[viewName] || 'block';

        document.querySelectorAll('[data-view]').forEach(el => {
            el.classList.remove('is-active');
            if (el.dataset.view === viewName) el.classList.add('is-active');
        });

        if (viewName === 'dashboard') this.renderDashboard();
    },

    initSortable() {
        const options = {
            group: 'shared',
            sort: false, // Disable reordering within the same column
            animation: 150,
            ghostClass: 'sortable-ghost',
            dragClass: 'sortable-drag',
            onEnd: async (evt) => {
                const itemEl  = evt.item;
                const taskId  = itemEl.dataset.id;
                const newStatus = evt.to.dataset.status;
                const oldStatus = evt.from.dataset.status;

                const task = this.state.tasks.find(t => t.id === taskId);
                if (task && newStatus !== oldStatus) {
                    task.status = newStatus;

                    if (newStatus === 'done' && oldStatus !== 'done') {
                        task.completed = true;
                        this.awardPoints(10, 'Task Completed! +10 Points');
                        if (this.state.focusTask && this.state.focusTask.id === task.id) {
                            this.resetFocusTimer();
                        }
                    } else if (oldStatus === 'done' && newStatus !== 'done') {
                        task.completed = false;
                    }

                    await this._saveTask(task);
                    this.updateCounts();
                }
                
                // Always re-render to enforce strict chronological sorting order,
                // forcing the UI to snap back to the correct order if visually dragged within the same column.
                this.renderBoard();
            }
        };

        new Sortable(this.dom.cols.todo, options);
        new Sortable(this.dom.cols.inprogress, options);
        new Sortable(this.dom.cols.done, options);
    },

    // 6. Rendering
    renderAll() {
        this.renderBoard();
        this.updateGamificationWidget();
        this.renderDashboard();
    },

    renderBoard(searchQuery = '') {
        Object.values(this.dom.cols).forEach(col => col.innerHTML = '');

        let filteredTasks = this.state.tasks.filter(t => t.workspace === this.state.workspace && !t.deleted);

        if (searchQuery) {
            const query = searchQuery.toLowerCase();
            filteredTasks = filteredTasks.filter(t =>
                t.title.toLowerCase().includes(query) ||
                (t.desc && t.desc.toLowerCase().includes(query)) ||
                (t.tags && t.tags.some(tag => tag.toLowerCase().includes(query)))
            );
        }

        filteredTasks.sort((a, b) => {
            if (a.pinned !== b.pinned) return b.pinned ? 1 : -1;
            // Sort by creation time so newer tasks are at the bottom and are not dragged upward
            return new Date(a.createdAt || 0) - new Date(b.createdAt || 0);
        });

        filteredTasks.forEach(task => {
            const el = this.createTaskCard(task);
            if (task.status && this.dom.cols[task.status]) {
                this.dom.cols[task.status].appendChild(el);
            }
        });

        this.updateCounts();
    },

    updateCounts() {
        const counts = { todo: 0, inprogress: 0, done: 0 };
        this.state.tasks.forEach(t => {
            if (t.workspace === this.state.workspace && !t.deleted && counts[t.status] !== undefined) {
                counts[t.status]++;
            }
        });
        this.dom.counts.todo.textContent      = counts.todo;
        this.dom.counts.inprogress.textContent = counts.inprogress;
        this.dom.counts.done.textContent      = counts.done;
    },

    createTaskCard(task) {
        const card = document.createElement('div');
        card.className = `task-card p-3 sm:p-4 rounded-xl shadow-sm mb-2 relative group ${task.completed ? 'completed' : ''}`;
        card.dataset.id = task.id;

        const priorityColors = { low: 'badge-low', medium: 'badge-medium', high: 'badge-high' };
        const pColor = priorityColors[task.priority] || priorityColors.medium;

        const tagsHtml = task.tags ? task.tags.map(tag =>
            `<span class="text-[10px] font-semibold px-2 py-0.5 rounded-md bg-indigo-50 text-indigo-600 dark:bg-indigo-900/30 dark:text-indigo-400 border border-indigo-100 dark:border-indigo-800/50">${tag.trim()}</span>`
        ).join('') : '';

        const deadlineHtml = task.deadline ?
            `<div class="flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400 font-medium">
                <i class="fa-regular fa-clock"></i> <span>${this.formatDate(task.deadline)}</span>
            </div>` : '';

        const createdAtDate = new Date(task.createdAt || Date.now());
        const timeHtml = `<div class="flex items-center gap-1 text-[10px] text-slate-400 dark:text-slate-500 font-medium ${task.deadline ? 'mt-1' : ''}">
            <i class="fa-solid fa-clock-rotate-left"></i> <span>Added ${this.formatDate(task.createdAt || new Date().toISOString())} ${createdAtDate.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</span>
        </div>`;

        const pinIcon = task.pinned
            ? '<i class="fa-solid fa-thumbtack text-primary text-xs transform rotate-45"></i>'
            : '<i class="fa-solid fa-thumbtack text-slate-300 dark:text-slate-600 text-xs"></i>';

        // Sync indicator dot: grey = unsynced, faint = synced
        const syncDot = task.synced === false
            ? `<span title="Pending sync" class="inline-block w-1.5 h-1.5 rounded-full bg-amber-400 ml-1 flex-shrink-0"></span>`
            : '';

        card.innerHTML = `
            <div class="flex justify-between items-start mb-2 gap-2">
                <div class="flex items-start gap-3 w-full">
                    <input type="checkbox" class="task-checkbox mt-1 w-4 h-4 rounded text-primary focus:ring-primary dark:bg-slate-700 border-slate-300 dark:border-slate-600 cursor-pointer" ${task.completed || task.status === 'done' ? 'checked' : ''}>
                    <div class="flex-1 min-w-0">
                        <h4 class="task-title font-semibold text-slate-800 dark:text-slate-200 text-sm break-words leading-tight flex items-center gap-1">${task.title}${syncDot}</h4>
                        ${task.desc ? `<p class="mt-1 text-xs text-slate-500 dark:text-slate-400 line-clamp-2">${task.desc}</p>` : ''}
                    </div>
                </div>
            </div>

            <div class="flex flex-wrap gap-1.5 mb-3 px-7">
                <span class="text-[10px] font-bold px-2.5 py-0.5 rounded-md uppercase tracking-widest ${pColor}">${task.priority}</span>
                ${tagsHtml}
            </div>

            <div class="flex items-center justify-between pt-2 mt-1 border-t border-slate-100 dark:border-slate-700/50 gap-2">
                <div class="flex flex-col min-w-0 truncate">
                    ${deadlineHtml}
                    ${timeHtml}
                </div>
                <div class="flex items-center gap-1 ml-auto flex-shrink-0">
                    <button class="action-focus w-7 h-7 rounded-lg bg-indigo-50 dark:bg-slate-700 text-primary hover:bg-primary hover:text-white transition-colors flex items-center justify-center text-xs" title="Focus on task">
                        <i class="fa-solid fa-crosshairs"></i>
                    </button>
                    <button class="action-pin w-7 h-7 rounded-lg bg-slate-50 dark:bg-slate-700 text-slate-400 hover:text-orange-500 transition-colors flex items-center justify-center" title="Pin task">
                        ${pinIcon}
                    </button>
                    <button class="action-edit w-7 h-7 rounded-lg bg-slate-50 dark:bg-slate-700 text-slate-400 hover:text-primary transition-colors flex items-center justify-center text-xs" title="Edit">
                        <i class="fa-solid fa-pen"></i>
                    </button>
                    <button class="action-delete w-7 h-7 rounded-lg bg-slate-50 dark:bg-slate-700 text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/30 transition-colors flex items-center justify-center text-xs" title="Delete">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
            </div>
        `;

        return card;
    },

    // 7. Modal & Task Actions
    openModal(task = null) {
        if (task) {
            this.dom.modalTitle.textContent = 'Edit Task';
            this.state.editingTaskId = task.id;
            this.dom.taskTitle.value    = task.title;
            this.dom.taskDesc.value     = task.desc || '';
            this.dom.taskPriority.value = task.priority;
            this.dom.taskDate.value     = task.deadline || '';
            this.dom.taskTags.value     = task.tags ? task.tags.join(', ') : '';
        } else {
            this.dom.modalTitle.textContent = 'New Task';
            this.state.editingTaskId = null;
            this.dom.taskForm.reset();
            this.dom.taskPriority.value = 'medium';
        }
        this.dom.modal.classList.add('is-open');
        setTimeout(() => this.dom.taskTitle.focus(), 100);
    },

    closeModal() {
        this.dom.modal.classList.remove('is-open');
        this.dom.taskForm.reset();
        this.state.editingTaskId = null;
    },

    openDeleteModal(id) {
        this.state.taskToDeleteId = id;
        this.dom.deleteModal.classList.add('is-open');
    },

    closeDeleteModal() {
        this.dom.deleteModal.classList.remove('is-open');
        this.state.taskToDeleteId = null;
    },

    async saveTaskFromForm() {
        const title    = this.dom.taskTitle.value.trim();
        const desc     = this.dom.taskDesc.value.trim();
        const priority = this.dom.taskPriority.value;
        const deadline = this.dom.taskDate.value;
        const tagsInput = this.dom.taskTags.value;
        const tags = tagsInput ? tagsInput.split(',').map(t => t.trim()).filter(t => t) : [];

        if (!title) return;

        if (this.state.editingTaskId) {
            const task = this.state.tasks.find(t => t.id === this.state.editingTaskId);
            if (task) {
                task.title    = title;
                task.desc     = desc;
                task.priority = priority;
                task.deadline = deadline;
                task.tags     = tags;
                await this._saveTask(task);
                this.showToast('Task updated successfully', 'success');
            }
        } else {
            const newTask = {
                id:        't_' + Date.now().toString(),
                title,
                desc,
                priority,
                deadline,
                tags,
                status:    'todo',
                workspace: this.state.workspace,
                pinned:    false,
                completed: false,
                deleted:   false,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                synced:    false,
            };
            this.state.tasks.push(newTask);
            await DB.put(newTask);
            SyncManager.triggerSync();
            this.showToast('New task added', 'success');
        }

        this.renderBoard();
        this.closeModal();
    },

    deleteTask(id) {
        this.openDeleteModal(id);
    },

    async executeDeleteTask(id) {
        const task = this.state.tasks.find(t => t.id === id);
        if (task) {
            // Soft-delete: mark deleted + unsynced so Supabase learns about it
            task.deleted = true;
            await this._saveTask(task);
        }
        // Remove from in-memory list so it's hidden immediately
        this.state.tasks = this.state.tasks.filter(t => t.id !== id);
        this.renderBoard();
        this.showToast('Task deleted', 'info');

        if (this.state.focusTask && this.state.focusTask.id === id) {
            this.resetFocusTimer();
            this.dom.focusTitle.textContent = 'No task selected for focus.';
            this.state.focusTask = null;
        }

        this.closeDeleteModal();
    },

    editTask(id) {
        const task = this.state.tasks.find(t => t.id === id);
        if (task) this.openModal(task);
    },

    async togglePin(id) {
        const task = this.state.tasks.find(t => t.id === id);
        if (task) {
            task.pinned = !task.pinned;
            await this._saveTask(task);
            this.renderBoard();
        }
    },

    async toggleTaskCompletion(id, isCompleted) {
        const task = this.state.tasks.find(t => t.id === id);
        if (task) {
            task.completed = isCompleted;
            if (isCompleted && task.status !== 'done') {
                task.status = 'done';
                this.awardPoints(10, 'Task Completed! +10 Points');
            } else if (!isCompleted && task.status === 'done') {
                task.status = 'todo';
            }
            await this._saveTask(task);
            this.renderBoard();
        }
    },

    // 8. Focus Mode
    setFocusTask(id) {
        const task = this.state.tasks.find(t => t.id === id);
        if (task) {
            this.state.focusTask = task;
            this.dom.focusTitle.textContent = task.title;
            document.querySelector('[data-view="focus"]').click();
            this.resetFocusTimer();
        }
    },

    toggleFocusTimer() {
        if (!this.state.focusTask) {
            this.showToast('Please select a task from the board first', 'error');
            return;
        }
        if (this.state.isTimerRunning) {
            clearInterval(this.state.focusTimer);
            this.state.isTimerRunning = false;
            this.dom.focusStartBtn.innerHTML = '<i class="fa-solid fa-play ml-1"></i>';
        } else {
            this.state.isTimerRunning = true;
            this.dom.focusStartBtn.innerHTML = '<i class="fa-solid fa-pause"></i>';
            this.state.focusTimer = setInterval(() => {
                this.state.timeLeft--;
                this.updateFocusDisplay();
                if (this.state.timeLeft <= 0) this.completeFocusSession();
            }, 1000);
        }
    },

    resetFocusTimer() {
        clearInterval(this.state.focusTimer);
        this.state.isTimerRunning = false;
        this.state.timeLeft = 25 * 60;
        this.dom.focusStartBtn.innerHTML = '<i class="fa-solid fa-play ml-1"></i>';
        this.updateFocusDisplay();
    },

    updateFocusDisplay() {
        const m = Math.floor(this.state.timeLeft / 60);
        const s = this.state.timeLeft % 60;
        this.dom.focusTime.textContent = `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;

        const circle = this.dom.focusCircle;
        const r = circle.r?.baseVal?.value || 133;
        const circumference = 2 * Math.PI * r;
        circle.style.strokeDasharray = circumference;
        const totalDuration = 25 * 60;
        const offset = circumference - (this.state.timeLeft / totalDuration) * circumference;
        circle.style.strokeDashoffset = offset;
    },

    completeFocusSession() {
        clearInterval(this.state.focusTimer);
        this.state.isTimerRunning = false;
        this.dom.focusStartBtn.innerHTML = '<i class="fa-solid fa-play ml-1"></i>';
        this.showToast('Focus session completed! Awesome job.', 'success');
        this.awardPoints(25, 'Deep Work Session! +25 Points');
        this.state.timeLeft = 25 * 60;
        this.updateFocusDisplay();
    },

    // 9. Gamification & Dashboard
    updateStreak() {
        const today   = this.getTodayDate();
        const lastLogin = this.state.gamification.lastLoginDate;
        if (lastLogin !== today) {
            if (lastLogin) {
                const yesterday = new Date();
                yesterday.setDate(yesterday.getDate() - 1);
                const yesterdayStr = yesterday.toISOString().split('T')[0];
                if (lastLogin !== yesterdayStr) {
                    this.state.gamification.streak = 0;
                }
            }
            this.state.gamification.lastLoginDate = today;
            this.saveGami();
        }
    },

    awardPoints(pts, msg) {
        this.state.gamification.points         += pts;
        this.state.gamification.tasksCompleted += 1;
        this.state.gamification.streak          = Math.max(1, this.state.gamification.streak);
        this.saveGami();
        this.updateGamificationWidget();
        this.renderDashboard();
        if (msg) this.showToast(msg, 'success');
    },

    updateGamificationWidget() {
        const currentPoints  = this.state.gamification.points;
        const level          = Math.floor(currentPoints / 100) + 1;
        const pointsInLevel  = currentPoints % 100;
        this.dom.wlLevel.textContent  = level;
        this.dom.wlPoints.textContent = pointsInLevel;
        this.dom.wlStreak.textContent = this.state.gamification.streak;
        this.dom.wlProgress.style.width = `${(pointsInLevel / 100) * 100}%`;
    },

    renderDashboard() {
        const totalCompleted = this.state.gamification.tasksCompleted ||
            this.state.tasks.filter(t => t.completed || t.status === 'done').length;
        this.dom.dashCompleted.textContent = totalCompleted;
        this.dom.dashStreak.textContent    = this.state.gamification.streak;
        this.dom.dashPoints.textContent    = this.state.gamification.points;
    },

    // 10. Utils
    showToast(message, type = 'info') {
        const container = document.getElementById('toast-container');
        const toast     = document.createElement('div');
        const colors = {
            success: 'bg-emerald-500 text-white',
            error:   'bg-red-500 text-white',
            info:    'bg-slate-800 dark:bg-slate-700 text-white'
        };
        const icons = {
            success: '<i class="fa-solid fa-check-circle"></i>',
            error:   '<i class="fa-solid fa-exclamation-circle"></i>',
            info:    '<i class="fa-solid fa-info-circle"></i>'
        };
        toast.className = `flex items-center gap-3 px-4 py-3 rounded-xl shadow-xl font-medium text-sm toast-enter ${colors[type]} pointer-events-auto`;
        toast.innerHTML = `${icons[type]} <span>${message}</span>`;
        container.appendChild(toast);
        setTimeout(() => {
            toast.classList.remove('toast-enter');
            toast.classList.add('toast-exit');
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    },

    formatDate(dateString) {
        const options = { month: 'short', day: 'numeric' };
        return new Date(dateString).toLocaleDateString('en-US', options);
    }
};

// Expose App globally so SyncManager.pullFromSupabase() can trigger re-renders
window.App = App;

// Start the app when DOM loads
document.addEventListener('DOMContentLoaded', () => App.init());
