export class Memory {
    constructor(memory = "", retention = "0", fresh = false) {
        this.memory = memory;
        this.retention = retention;
        this.fresh = fresh;
    }

    static fromJson(json) {
        return new Memory(json?.memory || "", json?.retention || "0", json?.fresh || false);
    }

    toJson() {
        return {
            memory: this.memory,
            retention: this.retention,
            fresh: this.fresh
        };
    }

    toMemoryLine(ignoreRetention) {
        if (ignoreRetention || (this.fresh || Memory.shouldPickMemory(this.retention))) {
            return this.memory;
        }
        return null;
    }

    static shouldPickMemory(retentionInput) {
        const retention = Math.max(0, Math.min(100, Number(retentionInput)));
        let probability = 0;

        if (retention <= 10) {
            probability = retention / 100;
        } else if (retention <= 50) {
            const t = (retention - 10) / (50 - 10);
            probability = 0.10 + (t * 0.85);
        } else {
            const t = (retention - 50) / (100 - 50);
            probability = 0.95 + (t * 0.05);
        }

        return Math.random() < probability;
    }
}

export class CharacterMemoryState {
    constructor() {
        // Safe default arrays to avoid null pointer crashes
        this.logicalMemories = [];
        this.emotionalMemories = [];
    }

    static fromJson(json) {
        const cms = new CharacterMemoryState();
        // Maps keys directly matching the LLM output JSON schema
        cms.logicalMemories = json?.["Logical Memories"]?.map(m => Memory.fromJson(m)) || [];
        cms.emotionalMemories = json?.["Emotional Memories"]?.map(m => Memory.fromJson(m)) || [];
        return cms;
    }

    toJson() {
        return {
            "Logical Memories": this.logicalMemories.map(m => m.toJson()),
            "Emotional Memories": this.emotionalMemories.map(m => m.toJson())
        };
    }

    makeStale() {
        for (const memory of this.logicalMemories) {
            memory.fresh = false;
        }
        for (const memory of this.emotionalMemories) {
            memory.fresh = false;
        }
    }

    processMemories(ignoreRetention) {
        const processArray = (arr) => {
            const result = [];
            // Iterating backwards keeps oldest memories at top, newest at bottom (recency bias optimization)
            for (let i = arr.length - 1; i >= 0; i--) {
                const line = arr[i].toMemoryLine(ignoreRetention);
                if (line) result.push(line);
            }
            return result;
        };

        return {
            logical: processArray(this.logicalMemories),
            emotional: processArray(this.emotionalMemories)
        };
    }
}

export class Memories {
    constructor() {
        this.memoryMap = {};
        this.thoughts = null;
        this.output = null;

        // transient
        this.$messageId = null;
    }

    static fromJson(json) {
        const instance = new Memories();
        const source = json?.memoryMap;
        if (source) {
            for (const [key, value] of Object.entries(source)) {
                instance.memoryMap[key] = CharacterMemoryState.fromJson(value);
            }
        }
        instance.thoughts = json.thoughts;
        instance.output = json.output;
        return instance;
    }

    static fromLlmJson(json) {
        const instance = new Memories();
        if (json) {
            for (const [characterName, characterData] of Object.entries(json)) {
                instance.memoryMap[characterName] = CharacterMemoryState.fromJson(characterData);
            }
        }
        return instance;
    }

    toJson() {
        const serializedMap = {};
        for (const [characterName, characterState] of Object.entries(this.memoryMap)) {
            serializedMap[characterName] = characterState.toJson();
        }
        return {
            memoryMap: serializedMap,
            thoughts: this.thoughts,
            output: this.output,
        };
    }

    includeDiff(otherMemories) {
        for (const [key, value] of Object.entries(otherMemories.memoryMap)) {
            if (!this.memoryMap[key]) {
                this.memoryMap[key] = CharacterMemoryState.fromJson(otherMemories.memoryMap[key].toJson());
                this.memoryMap[key].makeStale();
            }
        }
    }

    makeStale() {
        for (const [key, value] of Object.entries(this.memoryMap)) {
            value.makeStale();
        }
    }

    getOutput() {
        return this.output;
    }

    toMemoryBlockAll(ignoreRetention = false) {
        return this.toMemoryBlock(Object.keys(this.memoryMap), ignoreRetention);
    }

    toMemoryBlockRaw(presentCharacters, ignoreRetention = false) {
        const memories = {};
        let hasAnyMemories = false;

        for (const character of presentCharacters) {
            if (this.memoryMap[character]) {
                const processed = this.memoryMap[character].processMemories(ignoreRetention);
                // Only include the character if they passed at least one RNG memory check
                if (processed.logical.length > 0 || processed.emotional.length > 0) {
                    memories[character] = processed;
                    hasAnyMemories = true;
                }
            }
        }
        return hasAnyMemories ? memories : null;
    }

    toMemoryBlock(presentCharacters) {
        const processedMemories = this.toMemoryBlockRaw(presentCharacters);
        if (!processedMemories) return "";

        let text = "[ MEMORIES OF PRESENT CHARACTERS:";
        for (const [character, categories] of Object.entries(processedMemories)) {
            text += `\n # ${character}:`;

            if (categories.logical.length > 0) {
                text += "\n  - Logical/Facts:";
                for (const memory of categories.logical) {
                    text += `\n    * ${memory}`;
                }
            }

            if (categories.emotional.length > 0) {
                text += "\n  - Emotional/Nuance:";
                for (const memory of categories.emotional) {
                    text += `\n    * ${memory}`;
                }
            }
        }
        return text + "\n ]";
    }
}
