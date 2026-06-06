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
import {characters, getCharacterCardFields, getMaxPromptTokens, this_chid} from "../../../../script.js";
import {getWorldInfoPrompt} from "../../../world-info.js";
import {MEMORY_SCHEMA, NPC_MEMORY_GEN_PROMPT_DEFAULTS} from "./prompts.js";

const MEMORY_KEY = "messageMemory";

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
        if (!mblock) {
            if (characterDetection()) {
                // TODO
            } else {
                mblock = new Memories();
                mblock.$messageId = null;
                const presentCharacters = await this.getPresentCharacters();
                for (let pc of presentCharacters) {
                    mblock.memoryMap[pc] = CharacterMemoryState.fromJson({});
                }
            }
        }

        mblock.makeStale();
        mblock.thoughts = undefined;
        mblock.$messageId = undefined;

        const currentMemories = JSON.stringify(mblock.toJson());
        let messageData = (await window.enerccio_compat?.messageProcessor(m.mes, { 'role': m.is_user ? 'user' : (m.is_system ? 'system' : 'assistant'), 'content': m.mes }, {
            imprint: false,
            messageId: message
        })) || m.mes;
        if (message > 1) {
            const pm = context.chat[message - 1];
            if (pm.is_user) {
                // include last user message into detection
                messageData = pm.name + ": " + pm.mes + "\n\n" + messageData;
            }
        }

        const promptText = compilePromptTemplate(getSettings(SETTING_MEM_GEN_PROMPT, false, NPC_MEMORY_GEN_PROMPT_DEFAULTS), {
            currentMemory: currentMemories,
            sceneToProcess: messageData
        });

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

            log("Data from LLM: " + text);

            const dataFromLLM = extractAndParseJson(text);
            const newMemories = Memories.fromJson(dataFromLLM);
            newMemories.includeDiff(mblock);
            newMemories.$messageId = message;
            newMemories.thoughts = reasoningText;
            this.persistMemoryState(newMemories);
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

    async insertMemories(data) {
        const lastMemory = this.getLastMemoryBlock();
        if (lastMemory) {
            const context = SillyTavern.getContext();
            const text = lastMemory.toMemoryBlock(await this.getPresentCharacters(context.chat.length - 1));
            if (text) {
                for (let i = data.chat.length - 1; i >= 0; i--) {
                    if (data.chat[i].role === 'user') {
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
        eventSource.on(event, async (data) => {
            if (areMemoriesEnabled()) {
                await mm.insertMemories(data);
            }
        });
    }

    for (let event of [event_types.CHAT_CHANGED]) {
        eventSource.on(event, () => {
            mm.onChatReset();
        });
    }

});
