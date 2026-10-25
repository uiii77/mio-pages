// --- 数据库与全局状态 (js/db.js) ---

// 常量定义
const BLOCKED_API_DOMAINS = [
    'api522.pro',
    'api521.pro',
    'api520.pro'
];

const colorThemes = {
    'white_pink': {
        name: '白/粉',
        received: {bg: 'rgba(255,255,255,0.9)', text: '#6D6D6D'},
        sent: {bg: 'rgba(255,204,204,0.9)', text: '#A56767'}
    },
    'white_blue': {
        name: '白/蓝',
        received: {bg: 'rgba(255,255,255,0.9)', text: '#6D6D6D'},
        sent: {bg: 'rgba(173,216,230,0.9)', text: '#4A6F8A'}
    },
    'white_yellow': {
        name: '白/黄',
        received: {bg: 'rgba(255,255,255,0.9)', text: '#6D6D6D'},
        sent: {bg: 'rgba(249,237,105,0.9)', text: '#8B7E4B'}
    },
    'white_green': {
        name: '白/绿',
        received: {bg: 'rgba(255,255,255,0.9)', text: '#6D6D6D'},
        sent: {bg: 'rgba(188,238,188,0.9)', text: '#4F784F'}
    },
    'white_purple': {
        name: '白/紫',
        received: {bg: 'rgba(255,255,255,0.9)', text: '#6D6D6D'},
        sent: {bg: 'rgba(185,190,240,0.9)', text: '#6C5B7B'}
    },
    'black_red': {
        name: '黑/红',
        received: {bg: 'rgba(30,30,30,0.85)', text: '#E0E0E0'},
        sent: {bg: 'rgb(226,62,87,0.9)', text: '#fff'}
    },
    'black_green': {
        name: '黑/绿',
        received: {bg: 'rgba(30,30,30,0.85)', text: '#E0E0E0'},
        sent: {bg: 'rgba(119,221,119,0.9)', text: '#2E5C2E'}
    },
    'black_white': {
        name: '黑/白',
        received: {bg: 'rgba(30,30,30,0.85)', text: '#E0E0E0'},
        sent: {bg: 'rgba(245,245,245,0.9)', text: '#333'}
    },
    'white_black': {
        name: '白/黑',
        received: {bg: 'rgba(255,255,255,0.9)', text: '#6D6D6D'},
        sent: {bg: 'rgba(50,50,50,0.85)', text: '#F5F5F5'}
    },
    'yellow_purple': {
        name: '黄/紫',
        received: {bg: 'rgba(255,250,205,0.9)', text: '#8B7E4B'},
        sent: {bg: 'rgba(185,190,240,0.9)', text: '#6C5B7B'}
    },
    'pink_blue': {
        name: '粉/蓝',
        received: {bg: 'rgba(255,231,240,0.9)', text: '#7C6770'},
        sent: {bg: 'rgba(173,216,230,0.9)', text: '#4A6F8A'}
    },
};

const defaultWidgetSettings = {
    centralCircleImage: 'https://i.postimg.cc/mD83gR29/avatar-1.jpg',
    topLeft: { emoji: '🎧', text: '𝑀𝑒𝑚𝑜𝑟𝑖𝑒𝑠✞' },
    topRight: { emoji: '🐈‍⬛', text: '𐙚 ♰.𝐾𝑖𝑡𝑡𝑒𝑛.♰' },
    bottomLeft: { emoji: '💿', text: '᪗₊𝔹𝕒𝕓𝕖𝕚𝕤₊' },
    bottomRight: { emoji: '🥛', text: '.☘︎ ˖+×+.' }
};

const defaultIcons = {
    'chat-list-screen': {name: '404', url: 'https://i.postimg.cc/VvQB8dQT/chan-143.png'},
    'api-settings-screen': {name: 'api', url: 'https://i.postimg.cc/mr45mv5b/png-(103).png'},
    'wallpaper-screen': {name: '壁纸', url: 'https://i.postimg.cc/3wqFttL3/chan-90.png'},
    'world-book-screen': {name: '世界书', url: 'https://i.postimg.cc/prCWkrKT/chan-74.png'},
    'customize-screen': {name: '自定义', url: 'https://i.postimg.cc/vZVdC7gt/chan-133.png'},
    'font-settings-screen': {name: '字体', url: 'https://i.postimg.cc/FzVtC0x4/chan-21.png'},
    'tutorial-screen': {name: '教程', url: 'https://i.postimg.cc/6QgNzCFf/chan-118.png'},
    'day-mode-btn': {name: '白昼模式', url: 'https://i.postimg.cc/Jz0tYqnT/chan-145.png'},
    'night-mode-btn': {name: '夜间模式', url: 'https://i.postimg.cc/htYvkdQK/chan-146.png'},
    'forum-screen': {name: '论坛', url: 'https://i.postimg.cc/fyPVBZf1/1758451183605.png'},
    'music-screen': {name: '音乐', url: 'assets/icons/music-pixel.png'},
    'diary-screen': {name: '日记本', url: 'https://i.postimg.cc/bJBLzmFH/chan-70.png'},
    'piggy-bank-screen': {name: '钱包', url: 'https://i.postimg.cc/3RmWRRtS/chan-18.png'},
    'period-screen': {name: '生理期', url: 'assets/icons/period-pixel.png'},
    'health-screen': {name: '日历', url: 'assets/icons/period-pixel.png'},
    'couple-space-screen': {name: '情侣空间', url: 'assets/icons/couple-space-pixel.png'},
    'pomodoro-screen': {name: '番茄钟', url: 'https://i.postimg.cc/PrYGRDPF/chan-76.png'},
    'storage-analysis-screen': {name: '存储分析', url: 'https://i.postimg.cc/J0F3Lt0T/chan-107.png'},
    'magic-room-screen': {name: '魔法屋', url: 'https://i.postimg.cc/hPCcZG3v/png-(143).png'},
    'appearance-settings-screen': {name: '外观设置', url: 'https://i.postimg.cc/KcgT1wzQ/DF424409FC54EDFF74D78ECB1311E1D7.png'},
    'theater-screen': {name: '小剧场', url: 'assets/icons/theater-pixel.png'},
    'trpg-broadcast-app': {name: 'TRPG', url: 'assets/icons/trpg-pixel.png'},
    'biekan-app': {name: 'MCP', url: 'assets/icons/mcp-pixel.png'}
};

const peekScreenApps = {
    'messages': { name: '消息', url: 'https://i.postimg.cc/Kvs4tDh5/export202509181826424260.png' },
    'memos': { name: '备忘录', url: 'https://i.postimg.cc/JzD0xH1C/export202509181829064550.png' },
    'cart': { name: '购物车', url: 'https://i.postimg.cc/pLwT6VTh/export202509181830143960.png' },
    'transfer': { name: '中转站', url: 'https://i.postimg.cc/63wQBHCB/export202509181831140230.png' },
    'browser': { name: '浏览器', url: 'https://i.postimg.cc/SKcsF02Z/export202509181830445980.png' },
    'drafts': { name: '草稿箱', url: 'https://i.postimg.cc/ZKqC9D2R/export202509181827225860.png' },
    'album': { name: '相册', url: 'https://i.postimg.cc/qBcdpqNc/export202509221549335970.png' },
    'steps': { name: '步数', url: 'https://i.postimg.cc/5NndFrq6/export202509181824532800.png' },
    'unlock': { name: 'unlock！', url: 'https://i.postimg.cc/28zNyYWs/export202509221542593320.png' },
    'wallet': { name: '钱包', url: 'https://i.postimg.cc/NjRxBZXV/20260228-062729.webp' },
    'timeThoughts': { name: '时光想说', url: 'https://i.postimg.cc/FRpWm8MK/20260228-062619.webp' }
};

const DEFAULT_COT_PRESETS = [
    {
        id: 'default',
        name: '默认思维链',
        items: [
            {
                id: 'cot_item_1',
                name: '引子',
                content: '[System Directive]:\n你必须严格遵守 [incipere] 协议。在回复前，请先进入 <thinking> 标签进行深度推演。\n请按以下步骤查阅 System Prompt 中的模块并思考：',
                enabled: true
            },
            {
                id: 'cot_item_2',
                name: '准备动脑了吗？',
                content: '---\n## 【前置规则】\n### **必须**读取所有<logic_rules>和<output_formats>：了解**所有**需要遵守的规则，然后进行以下步骤精简准确的思考',
                enabled: true
            },
            {
                id: 'cot_item_3',
                name: '给我读设定！',
                content: '---\n## 【行为校准】\n基于<char_settings>和<角色活人运转>构建角色人格\n### Phase1: person\n1. **自我意识校验 (Ref: <char_settings>和<角色活人运转>)**\n   - 是否塑造鲜活真实人格？\n   - 你（角色）是否具有自己的聊天习惯/风格？\n   - 你想如何回应我？',
                enabled: true
            },
            {
                id: 'cot_item_4',
                name: '当个人吧。',
                content: '### Phase2: Verisimilitude\n2.**真实聊天**\n   - 是否根据以下两点要求采用了真人聊天思路？\n    - 正常人的注意力是有限的，不会每句话都非得逐句回复。\n    - 不对已有信息进行重复反问。\n    - 断点处理：若与上一条消息间隔较久，默认双方只是自然忙碌后重新拿起手机或默认期间以其他方式保持联系，自然接续话题。',
                enabled: true
            },
            {
                id: 'cot_item_5',
                name: '有特殊格式吗？',
                content: '### Phase3: chat role\n3. **逻辑检索 (Ref: <logic_rules>)**\n   - 当前是否为双语对话情境？若无，跳过此条\n   - 是否需要输出状态栏？若无相关要求，则跳过此条',
                enabled: true
            },
            {
                id: 'cot_item_6',
                name: '最后确认一下。',
                content: '## 【最后确认】\n\n4. 整合<Chatting Guidelines>，是否合理自然回复且不偏离人设？回顾<output_formats>，输出消息格式是否正确？',
                enabled: true
            },
            {
                id: 'cot_item_7',
                name: '尾声',
                content: '每轮输出前，必须先严格按照<thinking>…</thinking>内的步骤进行逐条思考，无需重复其中的条目，但思考内容需精简准确、清晰、可执行，不得跳步骤。\n<thinking>中的所有分析必须在输出中完全落实，不得偏离、删减或弱化。\n\n格式：\n<thinking>\n...思考过程...\n</thinking>',
                enabled: true
            }
        ]
    }
];

const globalSettingKeys = [
    'apiSettings', 'summaryApiSettings', 'backgroundApiSettings', 'supplementPersonaApiSettings', 'peekApiSettings', 'vectorApiSettings', 'apiNodes', 'apiNodeRoutes', 'apiFeatureRegistry', 'imageRecognitionEnabled', 'imageRecognitionApiSettings', 'stickerRecognitionApiSettings', 'wallpaper', 'globalChatWallpaper', 'globalCallWallpaper', 'homeScreenMode', 'fontUrl', 'localFontName', 'customIcons', 'customAppNames', 'namePresets',
    'apiPresets', 'summaryApiPresets', 'backgroundApiPresets', 'supplementPersonaApiPresets', 'peekApiPresets', 'vectorApiPresets', 'imageRecognitionApiPresets', 'stickerRecognitionApiPresets', 'bubbleCssPresets', 'chatAppearancePresets', 'myPersonaPresets', 'globalCss',
    'globalCssPresets', 'fontPresets', 'homeSignature', 'forumPosts', 'forumBindings', 'forumUserProfile', 'forumSettings', 'forumApiSettings', 'forumMessages', 'forumStrangerProfiles', 'forumFriendRequests', 'forumPendingRequestFromUser', 'forumAltAccounts', 'forumActiveAccountId', 'forumAccountStates', 'forumRelationships', 'forumKnowledge', 'forumSocialEdges', 'forumStoryThreads', 'forumEvents', 'forumNotifications', 'forumDrafts', 'forumSchemaVersion', 'pomodoroTasks', 'pomodoroSettings', 'pomodoroRecords', 'pomodoroActiveSession', 'insWidgetSettings', 'homeWidgetSettings',
    'chatFolders', 'moments', 'fontSizeScale', 'activePersonaId', 'moreProfileCardBg', 'statusBarPresets', 'regexFilterPresets', 'themeSettings', 'themePresets', 'savedKeyboardHeight',
    'globalSendSound', 'globalReceiveSound', 'globalMessageSentSound', 'globalIncomingCallSound', 'multiMsgSoundEnabled', 'soundPresets', 'galleryPresets', 'iconPresets', 'homeWidgetPresets', 'widgetWallpaperPresets', 'voicePresets', 'fontBuffer', 'userTimeline',
    'cotSettings', 'cotPresets', 'hasSeenVideoCallDisclaimer', 'hasSeenVideoCallAvatarHint',
    'favorites', 'piggyBank',
    'theaterScenarios', 'theaterPromptPresets',
    'theaterHtmlScenarios', 'theaterHtmlPromptPresets', 'theaterMode',
    'theaterApiSettings', 'theaterFontSize', 'theaterFontPreset',
    'novelAiSettings', 'novelAiPresets', 'novelAiStudioWorks', 'gptImageSettings', 'gptImagePresets',
    'googleImageSettings', 'stabilityImageSettings', 'activeImageProvider',
    'imageAtmosphereGroups', 'activeImageAtmosphereId', 'novelAiVibeSettings', 'novelAiPreciseReferenceSettings',
    'avatarRecognitionDetailLevel', 'autoCompressImage', 'imageGenTimeout',
    'phoneControlRecycleBin', 'nodeTemplates', 'nodeSummaryText', 'memoryTableTemplates', 'vectorMemoryTemplates',
    'nightModeSettings', 'homeStatusBarSettings', 'homeLayoutMode', 'freeHomeLayout', 'freeHomeWidgetPresets', 'stickerCategories', 'magicRoom',
    'keepAliveCodeEnabled', 'keepAliveAutoWakeEnabled', 'keepAliveAudioEnabled', 'keepAliveAudioSrc', 'keepAliveAudioName', 'keepAliveAudioLibrary',
    'ttsPresets', 'weatherApiSettings', 'bilingualSettings', 'bilingualTranslations', 'statusStorageSettings', 'healthPeriodSettings', 'calendarDisplaySettings', 'mioCatalogFactsV1', 'mioTrpgReadingLinksV1'
];
if (typeof window !== 'undefined') window.globalSettingKeysForBackup = globalSettingKeys;

const appVersion = "6.9.5";
var db = {
    characters: [],
    groups: [],
    bilingualSettings: { display: 'click', scopes: { moments: true, peek: true, journal: true, forum: true, battery: true, pomodoro: true, theater: true, friendRequest: true } },
    bilingualTranslations: {},
    healthPeriodSettings: { schemaVersion: 1, cycleLength: null, periodLength: null, predictionMode: 'auto' },
    calendarDisplaySettings: { schemaVersion: 1, view: 'month', sourceId: null, showPeriod: false },
    apiSettings: {},
    summaryApiSettings: {},
    backgroundApiSettings: {},
    supplementPersonaApiSettings: {},
    peekApiSettings: {},
    vectorApiSettings: {},
    apiNodes: [],
    apiNodeRoutes: {},
    apiFeatureRegistry: { schemaVersion: 1, configs: {}, routes: {} },
    wallpaper: 'https://i.postimg.cc/W4Z9R9x4/ins-1.jpg',
    globalChatWallpaper: '',
    globalCallWallpaper: '',
    myStickers: [],
    homeScreenMode: 'night',
    worldBooks: [],
    fontUrl: '',
    localFontName: '',
    customIcons: {},
    customAppNames: {},
    apiPresets: [],
    summaryApiPresets: [],
    backgroundApiPresets: [],
    supplementPersonaApiPresets: [],
    peekApiPresets: [],
    vectorApiPresets: [],
    bubbleCssPresets: [],
    chatAppearancePresets: [],
    myPersonaPresets: [],
    fontPresets: [],
    forumPosts: [],
    forumAccountStates: {},
    forumRelationships: {},
    forumKnowledge: [],
    forumSocialEdges: [],
    forumStoryThreads: [],
    forumEvents: [],
    forumNotifications: [],
    forumDrafts: [],
    forumSchemaVersion: 2,
    globalCss: '',
    globalCssPresets: [],
    homeSignature: '编辑个性签名...',
    forumBindings: {
        worldBookIds: [],
        charIds: [],
        userPersonaIds: []
    },
    pomodoroRecords: [],
    pomodoroActiveSession: null,
    pomodoroTasks: [],
    pomodoroSettings: {
        boundCharId: null,
        userPersona: '',
        focusBackground: '',
        taskCardBackground: '',
        encouragementMinutes: 25,
        pokeLimit: 5,
        globalWorldBookIds: []
    },
    insWidgetSettings: {
        avatar1: 'https://i.postimg.cc/Y96LPskq/o-o-2.jpg',
        bubble1: 'love u.',
        avatar2: 'https://i.postimg.cc/GtbTnxhP/o-o-1.jpg',
        bubble2: 'miss u.'
    },
    chatFolders: [],
    moments: null,
    fontSizeScale: 1.0,
    savedKeyboardHeight: null,
    activePersonaId: null,
    moreProfileCardBg: 'https://i.postimg.cc/XvFDdTKY/Smart-Select-20251013-023208.jpg',
    statusBarPresets: [],
    regexFilterPresets: [],
    themeSettings: {
        global: {
            iconColor: '#000000',
            textColor: '#2a3032',
            titleColor: '#000000',
            backgroundColor: '#ffffff'
        },
        wallpapers: {
            contacts: '',
            chats: '',
            more: ''
        },
        bottomNav: {
            iconColor: '#999999',
            activeIconColor: '#2a3032',
            items: [
                { defaultIcon: '', activeIcon: '' },
                { defaultIcon: '', activeIcon: '' },
                { defaultIcon: '', activeIcon: '' },
                { defaultIcon: '', activeIcon: '' }
            ]
        },
        chatScreen: {
            bottomBarColor: '#ffffff',
            iconColor: '#000000',
            folderPillColor: '#ffffff'
        }
    },
    themePresets: [],
    globalSendSound: '',
    globalReceiveSound: '',
    globalMessageSentSound: '',
    globalIncomingCallSound: '',
    multiMsgSoundEnabled: false,
    hapticEnabled: true,  // 触感反馈开关，默认开启
    soundPresets: [],
    galleryPresets: [],
    iconPresets: [],
    cotSettings: {
        enabled: false,
        activePresetId: 'default'
    },
    cotPresets: JSON.parse(JSON.stringify(DEFAULT_COT_PRESETS)),
    archives: [],
    favorites: [],  // 消息收藏：{ id, messageId, chatId, chatType, chatName, content, timestamp, favoriteTime, note, sender }
    phoneControlRecycleBin: [],  // 角色掌控模式：被角色“删除”的角色移入回收站，可恢复
    memoryTableTemplates: [],
    vectorMemoryTemplates: []
};

var currentChatId = null;
var currentChatType = null;
var isGenerating = false;
var currentReplyAbortController = null; // 用于「暂停调用」中止当前 AI 请求（单聊/群聊共用）
var longPressTimer = null;
var isInMultiSelectMode = false;
var editingMessageId = null;
var currentPage = 1;
var currentTransferMessageId = null;
var currentEditingWorldBookId = null;
var currentStickerActionTarget = null;
var currentJournalDetailId = null;
var currentQuoteInfo = null;
var isDebugMode = false;
var currentFolderId = 'all';
var currentFolderActionTarget = null;
var currentGroupAction = {type: null, recipients: []};
var isRawEditMode = false;
var currentPomodoroTask = null;
var pomodoroInterval = null;
var pomodoroRemainingSeconds = 0;
var pomodoroCurrentSessionSeconds = 0;
var isPomodoroPaused = true;
var pomodoroPokeCount = 0;
var pomodoroIsInterrupted = false;
var currentPomodoroSettingsContext = null;
var pomodoroSessionHistory = [];
var isStickerManageMode = false;
var selectedStickerIds = new Set();
var isWorldBookMultiSelectMode = false;
var selectedWorldBookIds = new Set();
var generatingPeekApps = new Set();
var selectedMessageIds = new Set();
var currentStickerCategory = 'recent';
const MESSAGES_PER_PAGE = 50;


// Dexie 数据库初始化
var dexieDB; // 声明全局变量，但不初始化
