(function attachCharacterStatusUI(global) {
    'use strict';

    const state = { characterId: '', tab: 'schedule' };
    const byId = id => document.getElementById(id);

    function setup() {
        const screen = byId('schedule-screen');
        if (!screen || screen.dataset.statusReady) return;
        screen.dataset.statusReady = 'true';
        const entry = byId('schedule-open-btn');
        const label = entry?.querySelector('span');
        if (label) label.textContent = '角色状态';
        if (entry) entry.title = '角色状态';
        const oldEntry = byId('emotion-open-btn');
        if (oldEntry) { oldEntry.hidden = true; oldEntry.style.display = 'none'; }
        screen.querySelector('[role="tablist"]')?.addEventListener('click', event => {
            const tab = event.target.closest('[data-character-status-tab]')?.dataset.characterStatusTab;
            if (!tab || tab === state.tab) return;
            const service = tab === 'emotion' ? global.Emotion : global.Schedule;
            service?.open(state.characterId, { preserveView: true });
        });
        screen.querySelector('[role="tablist"]')?.addEventListener('keydown', event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const tabs = [...screen.querySelectorAll('[data-character-status-tab]')];
            const next = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs.at(-1) : tabs.find(tab => tab.dataset.characterStatusTab !== state.tab);
            next?.click(); next?.focus();
        });
        byId('character-status-settings-btn')?.addEventListener('click', () => global.openCharacterSettings?.({
            characterId: state.characterId, section: 'interaction.daily', returnTarget: 'schedule-screen',
            focusId: state.tab === 'emotion' ? 'setting-emotion-enabled' : 'setting-schedule-enabled',
        }));
    }

    function show(characterId, tab) {
        setup();
        state.characterId = characterId;
        state.tab = tab;
        for (const name of ['schedule', 'emotion']) {
            const selected = name === tab;
            const button = byId(`character-status-${name}-tab`);
            button?.setAttribute('aria-selected', String(selected));
            if (button) button.tabIndex = selected ? 0 : -1;
            const panel = byId(name === 'schedule' ? 'character-status-schedule-panel' : 'emotion-screen');
            if (panel) panel.hidden = !selected;
        }
        if (typeof switchScreen === 'function') switchScreen('schedule-screen');
    }

    global.CharacterStatusUI = { setup, show };
})(window);
