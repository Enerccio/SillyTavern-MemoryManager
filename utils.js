import {EXTENSION_NAME, EXTENSION_PATH, MODULE_NAME, VERSION} from './conf.js';
import {debounce} from '/scripts/utils.js';
import {chat_metadata, saveChatDebounced, saveSettingsDebounced} from '/script.js';
import {
    extension_settings,
    getContext,
    renderExtensionTemplateAsync,
    saveMetadataDebounced
} from '/scripts/extensions.js';
import {getPresetManager} from "/scripts/preset-manager.js";
import {ChatCompletionService, TextCompletionService} from "/scripts/custom-request.js";
import {t} from "/scripts/i18n.js";
import {NPC_GEN_PROMPT_DEFAULTS, NPC_MEMORY_GEN_PROMPT_DEFAULTS} from "./prompts.js";

export const SETTING_NPC_GEN_PROMPT = 'npcGenPrompt';
export const SETTING_MEM_GEN_PROMPT = 'memGenPrompt';

export function log() {
    console.log(`[${EXTENSION_NAME}]`, ...arguments);
}

export function error() {
    console.error(`[${EXTENSION_NAME}]`, ...arguments);
}

export function errorToast() {
    console.error(`[${EXTENSION_NAME}]`, ...arguments);
    toastr.error(Array.from(arguments).join(' '), EXTENSION_NAME);
}

export function toast(message, type="info") {
    // debounce the toast messages
    // noinspection JSUnresolvedReference
    toastr[type](message, EXTENSION_NAME);
}

export function escapeString(text) {
    // escape control characters in the text
    if (!text) return text
    return text.replace(/[\x00-\x1F\x7F]/g, function(match) {
        // Escape control characters
        switch (match) {
            case '\n': return '\\n';
            case '\t': return '\\t';
            case '\r': return '\\r';
            case '\b': return '\\b';
            case '\f': return '\\f';
            default: return '\\x' + match.charCodeAt(0).toString(16).padStart(2, '0');
        }
    });
}

export function unescapeString(text) {
    // given a string with escaped characters, unescape them
    if (!text) return text
    return text.replace(/\\[ntrbf0x][0-9a-f]{2}|\\[ntrbf]/g, function(match) {
        switch (match) {
            case '\\n': return '\n';
            case '\\t': return '\t';
            case '\\r': return '\r';
            case '\\b': return '\b';
            case '\\f': return '\f';
            default: {
                // Handle escaped hexadecimal characters like \\xNN
                const hexMatch = match.match(/\\x([0-9a-f]{2})/i);
                if (hexMatch) {
                    return String.fromCharCode(parseInt(hexMatch[1], 16));
                }
                return match; // Return as is if no match
            }
        }
    });
}

export const toastDebounced = debounce(toast, 500);

export function check_objects_different(obj_1, obj_2) {
    // check whether two objects are different by checking each key, recursively
    // if both are objects, recurse on each element of obj_1
    // The "instanceof" method is true for Objects, Arrays, and Sets.
    if (obj_1 instanceof Object && obj_2 instanceof Object) {
        let keys = Object.keys(obj_1).concat(Object.keys(obj_2))
        for (let key of keys) {
            if (check_objects_different(obj_1[key], obj_2[key])) {
                return true  // different
            }
        }
        return false  // not different
    } else {  // not both objects - check equality directly
        return obj_1 !== obj_2  // return if different
    }
}

export function getChatMetadata(key, copy=false) {
    // Get a key from chat metadata
    let value = chat_metadata[MODULE_NAME]?.[key]
    if (copy) {  // needed when retrieving objects
        return structuredClone(value)
    } else {
        return value
    }
}

export function setChatMetadata(key, value, copy=false) {
    // Set a key and value in chat metadata (persists with branches)
    if (copy) {
        value = structuredClone(value);
    }
    if (!chat_metadata[MODULE_NAME]) chat_metadata[MODULE_NAME] = {};
    chat_metadata[MODULE_NAME][key] = value;
    saveMetadataDebounced();
}

export function getData(message, key) {
    // get information from the message object
    return message?.extra?.[MODULE_NAME]?.[key];
}


export function setData(message, key, value) {
    // store information on the message object
    if (!message.extra) {
        message.extra = {};
    }
    if (!message.extra[MODULE_NAME]) {
        message.extra[MODULE_NAME] = {};
    }

    message.extra[MODULE_NAME][key] = value;

    // Also save on the current swipe info if present
    let swipe_index = message.swipe_id
    if (swipe_index && message.swipe_info?.[swipe_index]) {
        if (!message.swipe_info[swipe_index].extra) {
            message.swipe_info[swipe_index].extra = {};
        }
        message.swipe_info[swipe_index].extra[MODULE_NAME] = structuredClone(message.extra[MODULE_NAME])
    }

    saveChatDebounced();
}


export function cleanStringForHtml(text) {
    // clean a given string for use in a div title.
    return text.replace(/["&'<>]/g, function(match) {
        switch (match) {
            case '"': return "&quot;";
            case "&": return "&amp;";
            case "'": return "&apos;";
            case "<": return "&lt;";
            case ">": return "&gt;";
        }
    })
}

export async function countTokens(text, padding = 0) {
    // count the number of tokens in a text
    let ctx = getContext();
    return await ctx.getTokenCountAsync(text, padding);
}

export function asMessage(text, isAssistant) {
    return {
        content: text
    };
}


export function getPreset(profile, context) {
    const selectedApiMap = context.ConnectionManagerRequestService.validateProfile(profile);
    let presetManager;
    let preset = null;
    switch (selectedApiMap.selected) {
        case 'openai': {
            presetManager = getPresetManager(ChatCompletionService.TYPE);
        } break;
        case 'textgenerationwebui': {
            presetManager = getPresetManager(TextCompletionService.TYPE);
        } break;
    }
    if (presetManager) {
        if (profile.preset) {
            preset = presetManager.getCompletionPresetByName(profile.preset);
        } else {
            preset = presetManager.getSelectedPreset();
        }
        return presetManager.getPresetSettings(preset);
    }
    return null;
}

export function initializeRequestMetadata() {
    const connection_id = SillyTavern.getContext().extensionSettings.connectionManager.selectedProfile;;
    const connection = SillyTavern.getContext().ConnectionManagerRequestService.getProfile(connection_id);
    const preset = getPreset(connection, SillyTavern.getContext());

    return {
        cId: connection_id,
        connection: connection,
        preset: preset,
        num_predict: preset.genamt,
        total_size: preset.max_length,
        max_context_size: preset.max_length - preset.genamt
    };
}


export function setSettings(key, value, copy=false) {
    // Set a setting for the extension and save it
    if (copy) {
        value = structuredClone(value)
    }
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = {};
    }
    extension_settings[MODULE_NAME][key] = value;
    saveSettingsDebounced();
}

export function getSettings(key, copy=false, defval = "") {
    // Get a setting for the extension, or the default value if not set
    let value = extension_settings[MODULE_NAME]?.[key] ?? defval;
    if (copy) {  // needed when retrieving objects
        return structuredClone(value)
    } else {
        return value
    }
}

export function areMemoriesEnabled() {
    return String(getSettings('memoriesEnabled', false, "true")).toLowerCase() === 'true';
}

export function characterDetection() {
    return String(getSettings('characterDetection', false, "false")).toLowerCase() === 'true';
}

export function compilePromptTemplate(templateString, variables) {
    // Regular expression that finds anything inside {{ }}
    const mustacheRegex = /\{\{\s*([a-zA-Z0-9_]+)\s*}}/g;

    return templateString.replace(mustacheRegex, (match, key) => {
        // If the variable exists in our object, replace it; otherwise, keep the tag intact
        return variables[key] !== undefined ? variables[key] : match;
    });
}


export function checkConnectionProfilesActive() {
    // detect whether the connection profiles extension is active
    return !SillyTavern.getContext().extensionSettings.disabledExtensions.includes('connection-manager')
}

export function getConnectionProfiles() {
    // Get a list of available connection profiles
    if (!checkConnectionProfilesActive()) return [];  // if the extension isn't active, return
    return SillyTavern.getContext().extensionSettings.connectionManager.profiles
}

export function verify_connection_profile(id) {
    // check if the given connection profile ID is valid.
    if (!checkConnectionProfilesActive()) return;  // if the extension isn't active, return
    if (id === "") return true;  // no profile selected, always valid
    let data = getConnectionProfileData(id)  // found an existing profile for this ID
    return !!data;
}

export function getConnectionProfileData(id) {
    // Return the info for the given connection profile ID
    let data = getConnectionProfiles().find((p) => p.id === id);
    if (data) return data
    error(`Connection profile not found for ID: ${id}`)
}

export async function updateConnectionProfileDropdown() {
    // set the connection profile dropdown
    let $connection_select = $(`.${MODULE_NAME}_settings #connection_profile`);
    let connection_profiles = await getConnectionProfiles()
    $connection_select.empty();
    $connection_select.append(`<option value="">${t`Same as Current`}</option>`)
    for (let profile of connection_profiles) {  // construct the dropdown options
        $connection_select.append(`<option value="${profile.id}">${profile.name}</option>`)
    }

    let profile_id = getSettings('connection_profile')
    if (!verify_connection_profile(profile_id)) {
        toastDebounced(`Selected side query connection profile ID is invalid: ${profile_id}`, "warning")
        profile_id = ""  // fall back to "same as current"
    }
    $connection_select.val(profile_id)

    // set a click event to refresh the dropdown
    $connection_select.off('click').on('click', () => {
        setSettings('connection_profile', $connection_select.val());
        updateConnectionProfileDropdown();
    });
}

export async function loadSettings() {
    const settingsHtml = await renderExtensionTemplateAsync(
        EXTENSION_PATH,
        'settings',
        { title: EXTENSION_NAME, version: VERSION }
    );
    // noinspection JSUnresolvedReference
    $('#extensions_settings2').append(settingsHtml);

    await updateConnectionProfileDropdown();

    const $npcGenPrompt = $("#enerccio_memmanager_npcgen_prompt");
    $npcGenPrompt.on('input', () => {
        setSettings(SETTING_NPC_GEN_PROMPT, $npcGenPrompt.val());
    });
    const genSet = getSettings(SETTING_NPC_GEN_PROMPT, false, NPC_GEN_PROMPT_DEFAULTS) || NPC_GEN_PROMPT_DEFAULTS;
    $npcGenPrompt.val(genSet);
    setSettings(SETTING_NPC_GEN_PROMPT, genSet);

    const $npcMemGenPrompt = $("#enerccio_memmanager_memoryupdate_prompt");
    $npcMemGenPrompt.on('input', () => {
        setSettings(SETTING_MEM_GEN_PROMPT, $npcMemGenPrompt.val());
    });
    const memSet = getSettings(SETTING_MEM_GEN_PROMPT, false, NPC_MEMORY_GEN_PROMPT_DEFAULTS) || NPC_MEMORY_GEN_PROMPT_DEFAULTS;
    $npcMemGenPrompt.val(memSet);
    setSettings(SETTING_MEM_GEN_PROMPT, memSet);
}

export function extractAndParseJson(rawText) {
    try {
        // 1. Try a direct parse first just in case it's pristine
        return JSON.parse(rawText.trim());
    } catch (initialError) {
        // 2. If it fails, extract everything from the first '{' to the last '}'
        const jsonMatch = rawText.match(/\{[\s\S]*\}/);

        if (jsonMatch) {
            try {
                return JSON.parse(jsonMatch[0]);
            } catch (nestedError) {
                error("[SillyTavern-MemoryManager] Deep JSON parsing failed inside the extracted block.");
                throw nestedError;
            }
        }

        // If no curly brackets were found at all, rethrow the original error
        throw initialError;
    }
}
