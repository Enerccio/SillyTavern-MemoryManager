import {
    areMemoriesEnabled,
    characterDetection,
    compilePromptTemplate,
    getData,
    getSettings,
    loadSettings,
    SETTING_MEM_GEN_PROMPT,
    updateConnectionProfileDropdown,
    error, initializeRequestMetadata, log, setData, extractAndParseJson
} from "./utils.js";
import {event_types, eventSource} from "../../../events.js";
import {CharacterMemoryState, Memories} from "./memories.js";
import {groups, selected_group} from "../../../group-chats.js";
import {
    characters, extension_prompt_types,
    getCharacterCardFields,
    getMaxPromptTokens,
    setExtensionPrompt,
    this_chid
} from "/script.js";
import {getWorldInfoPrompt} from "../../../world-info.js";
import {MEMORY_SCHEMA, NPC_MEMORY_GEN_PROMPT_DEFAULTS} from "./prompts.js";
import {EXTENSION_NAME} from "./conf.js";

const MEMORY_KEY = "messageMemory";
const EXT_PROMPT = `${EXTENSION_NAME}_memory`

class MemoryManagement {

    constructor() {
        this.generatingMemories = {};
    }

    async onChatReset() {
        for (const [key, value] of Object.entries(this.generatingMemories)) {
            value.abort();
        }
        this.generatingMemories = {};
    }

    async evictGeneration(mId) {
        if (this.generatingMemories[mId]) {
            this.generatingMemories[mId].abort();
            delete this.generatingMemories[mId];
            // TODO: update Ui
        }
    }

    persistMemoryState(memoryState) {
        if (memoryState.$messageId !== null) {
            const context = SillyTavern.getContext();
            const m = context.chat[memoryState.$messageId];
            if (m) {
                setData(m, MEMORY_KEY, memoryState.toJson());
            }
        }
    }

    async processMessage(message, wasSwipe) {
        const context = SillyTavern.getContext();
        const m = context.chat[message];

        await this.evictGeneration(message);

        let mblock = this.getMemoryBlock(message - 1);
        const presentCharacters = await this.getPresentCharacters();
        if (!mblock) {
            mblock = new Memories();
            mblock.$messageId = null;
            for (let pc of presentCharacters) {
                mblock.memoryMap[pc] = CharacterMemoryState.fromJson({});
            }
        }

        mblock.makeStale();

        const currentMemories = JSON.stringify(mblock.toJson().memoryMap);
        let messageData = m.name + ": " + ((await window.enerccio_compat?.messageProcessor(m.mes, { 'role': m.is_user ? 'user' : (m.is_system ? 'system' : 'assistant'), 'content': m.mes }, {
            imprint: false,
            messageId: message
        }))) || m.mes;
        let startPoint = message;
        if (message > 1) {
            const pm = context.chat[message - 1];
            if (pm.is_user) {
                // include last user message into detection
                messageData = pm.name + ": " + pm.mes + "\n\n" + messageData;
                startPoint--;
            }
        }

        let previousScenes = [];
        // TODO: Settings
        for (let i=startPoint-1; i>=Math.max(0, startPoint - 6); i--) {
            const pastMessage = context.chat[i];
            let pastMessageData;
            if (pastMessage.is_user) {
                pastMessageData = pastMessage.name + ": " + pastMessage.mes + "\n\n" + messageData;
            } else if (!pastMessage.is_system) {
                pastMessageData = pastMessage.name + ": " + ((await window.enerccio_compat?.messageProcessor(pastMessage.mes, { 'role': pastMessage.is_user ? 'user' : (pastMessage.is_system ? 'system' : 'assistant'), 'content': pastMessage.mes }, {
                    imprint: false,
                    messageId: i
                }))) || pastMessage.mes;
            }
            if (pastMessageData) {
                previousScenes.push(pastMessageData);
            }
        }
        let previousSceneData = "";
        for (let i=previousScenes.length-1; i>=0; i--) {
            previousSceneData += "\n\n" + previousScenes[i];
        }

        const promptText = compilePromptTemplate(getSettings(SETTING_MEM_GEN_PROMPT, false, NPC_MEMORY_GEN_PROMPT_DEFAULTS), {
            currentMemory: currentMemories || "",
            sceneToProcess: messageData,
            previousScenes: previousSceneData,
        });

        log("Prompt for LLM: " + promptText);

        const metadata = initializeRequestMetadata();
        const profile = metadata.cId;
        this.generatingMemories[message] = new AbortController();

        let reasoningText = "";
        let text = "";
        try {
            const queries = await this.generatePrompt(messageData, promptText);
            let asyncGeneratorFunction = await context.ConnectionManagerRequestService.sendRequest(profile, queries,
                profile.max_tokens, {stream: true, signal: this.generatingMemories[message].signal, json_schema: MEMORY_SCHEMA});

            const asyncGenerator = asyncGeneratorFunction();
            while (true) {
                let r = await asyncGenerator.next();
                if (r.done) {
                    await this.evictGeneration(message)
                    break;
                }

                const returnFromGenerator = r.value;
                text = returnFromGenerator.text;
                reasoningText = returnFromGenerator.state?.reasoning;
            }

            try {
                const dataFromLLM = extractAndParseJson(text);
                log("Data from LLM: " + JSON.stringify(dataFromLLM, null, 2));
                const newMemories = Memories.fromLlmJson(dataFromLLM);
                newMemories.includeDiff(mblock);
                newMemories.$messageId = message;
                newMemories.thoughts = reasoningText;
                newMemories.output = newMemories.toMemoryBlock(presentCharacters);
                this.persistMemoryState(newMemories);
            } catch (syntaxFailed) {
                error("Failed to parse: " + text);
            }
        } catch (aborted) {
            if (aborted === 'userStopped') {
                log('Memory generation stopped');
            } else {
                error("Memory generation failed: " + aborted);
            }
        }

        await this.evictGeneration(message);
    }

    async generatePrompt(messageData, promptText) {
        const queries = [];

        let {
            description,
            personality,
            persona,
            scenario,
            mesExamples,
            system,
            jailbreak,
            charDepthQuery,
            creatorNotes,
        } = getCharacterCardFields();

        if (jailbreak) {
            queries.push({
                content: jailbreak,
                role: "system",
            });
        }
        if (system)
            queries.push({
                content: scenario,
                role: "system",
            });
        if (scenario)
            queries.push({
                content: scenario,
                role: "system",
            });
        if (persona)
            queries.push({
                content: persona,
                role: "system",
            });
        if (description)
            queries.push({
                content: description,
                role: "system",
            });
        if (personality)
            queries.push({
                content: personality,
                role: "system",
            });

        const globalScanData = {
            personaDescription: persona,
            characterDescription: description,
            characterPersonality: personality,
            characterDepthQuery: charDepthQuery,
            scenario: scenario,
            creatorNotes: creatorNotes,
            trigger: 'EnerccioMemories', // TODO settings
        };
        let this_max_context = getMaxPromptTokens();
        const {
            worldInfoString,
            worldInfoBefore,
            worldInfoAfter,
            worldInfoExamples,
            worldInfoDepth,
            outletEntries
        } = await getWorldInfoPrompt(messageData ? [ messageData ]: [ ], this_max_context, false, globalScanData);

        if (worldInfoBefore) {
            queries.push({
                content: worldInfoBefore,
                role: "system",
            });
        }
        if (worldInfoAfter) {
            queries.push({
                content: worldInfoAfter,
                role: "system",
            });
        }

        queries.push({ role: 'user', content: promptText });

        return queries;
    }

    getMemoryBlock(messageIdStart) {
        const context = SillyTavern.getContext();
        if (messageIdStart >= 0) {
            for (let i=Math.min(messageIdStart, context.chat.length-1); i>=0; i--) {
                const memData = getData(context.chat[i], MEMORY_KEY);
                if (memData) {
                    const memories = Memories.fromJson(memData);
                    memories.$messageId = i;
                    return memories;
                }
            }
        }
        return null;
    }

    getLastMemoryBlock() {
        return this.getMemoryBlock(SillyTavern.getContext().chat.length - 1);
    }

    async getPresentCharacters(messageId = undefined) {
        const clist = [];
        if (messageId !== undefined && characterDetection()) {
            // TODO
        }

        if (selected_group) {
            const group = groups.find((x) => x.id === selected_group);
            for (const m of group.members) {
                const character = characters[m];
                clist.push(character.name);
            }
        } else if (this_chid !== undefined) {
            const character = characters[this_chid];
            clist.push(character.name);
        }
        return clist;
    }

    async insertMemories(data, dryRun) {
        const lastMemory = this.getLastMemoryBlock();
        if (lastMemory) {
            const text = lastMemory.getOutput();
            if (text) {
                for (let i = data.chat.length - 1; i >= 0; i--) {
                    if (data.chat[i].role === 'user') {
                        if (!dryRun)
                            log("Data to LLM: " + text);
                        data.chat[i].content = `${text}\n\n` + data.chat[i].content;
                        return;
                    }
                }
            }
        }

    }
}

const mm = new MemoryManagement();

$(async function() {
    await updateConnectionProfileDropdown();
    await loadSettings();

    for (let event of [event_types.CHARACTER_MESSAGE_RENDERED]) {
        eventSource.on(event, async (message, wasSwipe) => {
            if (areMemoriesEnabled()) {
               await mm.processMessage(message, wasSwipe);
            }
        });
    }

    for (let event of [event_types.CHAT_COMPLETION_PROMPT_READY]) {
        eventSource.on(event, async (data, dryRun=false) => {
            if (areMemoriesEnabled()) {
                await mm.insertMemories(data, dryRun);
            }
        });
    }

    for (let event of [event_types.CHAT_CHANGED]) {
        eventSource.on(event, () => {
            mm.onChatReset();
        });
    }

});
