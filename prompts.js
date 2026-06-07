
export const NPC_GEN_PROMPT_DEFAULTS = `You are a precise entity-extraction engine. Your task is to analyze the provided scene text, cross-reference it with a list of known existing characters, and identify who is **physically present and actively participating** in the current scene.

### Strict Filtering Rules:
1. **Physical Presence Only:** Only include characters who are in the immediate room, area, or actively interacting with the protagonist/narrator in this specific moment.
2. **Exclude References:** Do NOT include characters who are merely mentioned in dialogue, recalled in memories, spoken of in the past tense, or existing as distant lore figures.

### Cross-Referencing Existing Characters:
You will be provided a list of "Existing Characters".
- If a character physically present in the text matches or is clearly the same entity as one in the "Existing Characters" list (even if the text uses a title, pronoun, descriptive phrase, or partial name), you **MUST** use the exact name string from that list.
- If a physically present character is completely new and does not match anyone on the list, generate a clean, concise name or identifier for them.

### Output Format:
You must respond **ONLY** with a valid JSON array of strings containing the names of the present characters. Do not include markdown formatting, do not include backticks, and do not include any conversational filler.

### Input Data:

Existing Characters:
{{existingCharacter}}

==== SCENE_TEXT_TO_GENERATE START =====
{{textToAnalyze}}
==== SCENE_TEXT_TO_GENERATE END =====

### JSON Output:`;


export const NPC_MEMORY_GEN_PROMPT_DEFAULTS = `You are a precise state-management engine for an RPG/roleplay application. Your task is to update the persistent memory states of multiple characters based on a new scene interaction.

You will be provided with the current memory state of the present characters and the text of the recent interaction. You must output a fully updated, consolidated JSON object containing the new memory states.

### Memory Type Definitions:
1. **Logical Memories:** Facts, actionable data, secrets, historical knowledge, plot points, and worldly information the character knows.
2. **Emotional Memories:** Feelings toward others, internal emotional states, psychological impacts, reactions to events, mood shifts, or deeply personal moments.

### Retention Scale Guidelines (0-100):
When creating or updating a memory, assign a \`"retention"\` value as a string integer from \`"0"\` to \`"100"\` based strictly on this mechanical distribution:
- **\`90\` to \`100\` (Core / Permanent):** Critical, life-altering plot twists, foundational core traits, or major secrets (e.g., "Kissed the princess", "Discovered the King is a traitor"). These have a 100% recall rate and will never fade unless explicitly overwritten.
- **\`50\` to \`89\` (High Priority / Relevant):** Significant plot updates, strong emotional impacts, or currently active goals (e.g., "The tavern is currently under attack", "Felt deeply insulted by the protagonist"). A score of \`50\` guarantees a 95% recall rate, making it a stable anchor for the current story arc.
- **\`11\` to \`49\` (Moderate / Contextual):** Secondary details or conversations that are good to remember for the immediate scene but will naturally drift away as the story progresses.
- **\`1\` to \`10\` (Mundane / Fleeting):** Minor daily tasks, passing remarks, or trivial sensory details (e.g., "Had breakfast", "Noticed it was raining outside"). A score of \`10\` drops to a 10% recall rate, ensuring the memory fades quickly and does not bloat future context windows.

### State Update Logic & Processing Rules:
Each individual memory in the array must be an object containing exactly three keys: \`"memory"\`, \`"retention"\`, and \`"fresh"\`.

For each character provided in the input state and present on scene, analyze the scene text and apply the following operations to both their "Logical Memories" and "Emotional Memories" arrays:

1. **Add New Memories:** If a new meaningful event, fact, or emotional shift occurs, create a new memory object. Set \`"fresh"\` to \`true\`. Assign a \`"retention"\` value as a string from \`"0"\` to \`"100"\` based on impact.
2. **Update Refreshed Memories:** If an existing memory is reinforced or relevant to the current scene, update its \`"retention"\` value and change its \`"fresh"\` key to \`true\`.
3. **Retain Untouched Memories:** If an existing memory was not mentioned, changed, or contradicted, keep it in the array as-is, but ensure its \`"fresh"\` key is set to \`false\`.
4. **Replace/Resolve Conflicts:** If the new scene directly contradicts or overwrites an existing memory, **remove** or rewrite the conflicting memory completely.
5. **Maintain Strict Ordering:**
   - Any memory where \`"fresh"\` is \`true\` MUST be placed at the **very front** (the beginning) of its respective array.
   - Any memory where \`"fresh"\` is \`false\` must remain in the array, but shifted below the fresh memories, maintaining their original relative order.
6. **Detect Temporal Shifts & Apply Decay:**
   Analyze the conversational context and the new interaction for any narrative indications of a significant passage of time (e.g., "the next day", "weeks later", "a year passes"). If a time skip has occurred, you must apply a **Temporal Decay Cycle** to all existing memories BEFORE processing new ones:
   - **Short Time Skips (Days/Weeks):** Reduce the \`retention"\` value of all non-fresh "Moderate/Contextual" memories (11–49) by 10–20 points. Completely delete "Mundane/Fleeting" memories (1–10).
   - **Major Time Skips (Months/Years):** Drastically purge the character's memory banks. Completely remove all memories with a retention score under \`50\`. Reduce the retention of "High Priority" memories (50–89) by 20–30 points to reflect fading details.
   - **Core/Permanent Memories (90–100):** These foundational truths, major secrets, and core trauma never decay due to time skips unless the narrative explicitly states they forgot or resolved them.

If a character is NOT present, do NOT include them in the result!



### Output Format:
You must respond **ONLY** with a valid JSON object matching the input structure. Do not include markdown formatting outside the JSON, do not include backticks, and do not include any conversational filler.

### Input Data:

===== CURRENT MEMORY STATE START =====
{{currentMemory}}
===== CURRENT MEMORY STATE END =====

===== PREVIOUS SCENES START =====
{{previousScenes}}
===== PREVIOUS SCENES END =====

===== SCENE TO EXTRACT MEMORIES FROM START =====
{{sceneToProcess}}
===== SCENE TO EXTRACT MEMORIES FROM END =====

### JSON Output:`;

export const MEMORY_SCHEMA = JSON.parse(`{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "CharacterMemoryState",
  "description": "A dynamic state object mapping character names to their logical and emotional persistent memories.",
  "type": "object",
  "additionalProperties": {
    "type": "object",
    "properties": {
      "Logical Memories": {
        "type": "array",
        "items": {
          "$ref": "#/definitions/MemoryItem"
        },
        "description": "An ordered list of factual knowledge, plot points, and worldly data known by the character."
      },
      "Emotional Memories": {
        "type": "array",
        "items": {
          "$ref": "#/definitions/MemoryItem"
        },
        "description": "An ordered list of feelings, interpersonal dynamics, and psychological reactions belonging to the character."
      }
    },
    "required": ["Logical Memories", "Emotional Memories"],
    "additionalProperties": false
  },
  "definitions": {
    "MemoryItem": {
      "type": "object",
      "properties": {
        "memory": {
          "type": "string",
          "description": "A concise encapsulation of the memory itself."
        },
        "retention": {
          "type": "string",
          "pattern": "^(100|[1-9]?[0-9])$",
          "description": "The memory strength represented as a string scale from '0' to '100'."
        },
        "fresh": {
          "type": "boolean",
          "description": "If memory was inserted or updated this turn."
        }
      },
      "required": ["memory", "retention", "fresh"],
      "additionalProperties": false
    }
  }
}`);
