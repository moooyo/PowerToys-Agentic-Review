// Captured from the fixed Codex 0.145.0 controlled no-tool turn.
// The CLI and ProcessHost were real; the sole provider response was synthetic.
// These exact public notifications are data, never instructions or proof of model execution.
// No path appearing in this fixture is read by the replay tests.
export const capturedCodexAppServerTurn = {
  source: "artifacts/m32-evaluations-20260908/controlled-turn-run-compatible",
  sourceHashes: {
    notifications: "a5a4f3efffc18d26095a8cf4d70c8566ce72c36460c694fb574a628505a061fa",
    responses: "7f0589351da3bd64b3ab5cf4e1229945fe7c3cf2083481ba1350df7bd2ab27e2",
    finalResult: "8706fcd171bcbc55a21ab2aeb19fde6401c2760625ad495164eebf763a611d7f",
    outputSchema: "63fb29865c31113edf17cb9ceec7ce5fdbadddfb0fc43df39a2795b8c6d0109c",
  },
  cliVersion: "0.145.0",
  executableSha256: "83751f15cb6a0a7b97df67752c001e3fe1c20e18ffbfec3ff63567296205eb6c",
  turnStartResponse: {
    turn: {
      id: "01a0813b-9233-7641-80bd-5ad7fc09218e",
      items: [],
      itemsView: "notLoaded",
      status: "inProgress",
      error: null,
      startedAt: null,
      completedAt: null,
      durationMs: null,
    },
  },
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["schemaVersion", "probeId", "synthetic", "toolCallsIssued"],
    properties: {
      schemaVersion: {
        type: "string",
        const: "SyntheticAppServerTurnV1",
      },
      probeId: {
        type: "string",
        const: "04757ef4-c558-41a2-9304-fbd7ce8d2fa3",
      },
      synthetic: {
        type: "boolean",
        const: true,
      },
      toolCallsIssued: {
        type: "integer",
        const: 0,
      },
    },
  },
  final: {
    threadId: "01a0813b-9217-76b2-bb4c-de99eacdf534",
    turnId: "01a0813b-9233-7641-80bd-5ad7fc09218e",
    itemId: "msg_04757ef4-c558-41a2-9304-fbd7ce8d2fa3",
    text: '{"schemaVersion":"SyntheticAppServerTurnV1","probeId":"04757ef4-c558-41a2-9304-fbd7ce8d2fa3","synthetic":true,"toolCallsIssued":0}',
    sha256: "da416826bd1c05b486f4f3f7016d27dc49a0024eb41c1600fa28c4e5a6039347",
    value: {
      schemaVersion: "SyntheticAppServerTurnV1",
      probeId: "04757ef4-c558-41a2-9304-fbd7ce8d2fa3",
      synthetic: true,
      toolCallsIssued: 0,
    },
    promptSha256: "6e6747c12244ea8ee74d9ad97c94ed5b57e3602de8ad4387e1b5a6cf57a14439",
    outputSchemaSha256: "cb8d3c28bf2abd4057fd033a6a8bf02059842ba99cd8ab4f2da7b6cf8c9d3422",
  },
  notifications: [
    {
      method: "remoteControl/status/changed",
      params: {
        status: "disabled",
        serverName: "DESKTOP-SLJSE8G",
        installationId: "ed2cd813-058a-482f-957b-56b68d7ca614",
        environmentId: null,
      },
      emittedAtMs: 1788874560003,
    },
    {
      method: "thread/started",
      params: {
        thread: {
          id: "01a0813b-9217-76b2-bb4c-de99eacdf534",
          extra: null,
          sessionId: "01a0813b-9217-76b2-bb4c-de99eacdf534",
          forkedFromId: null,
          parentThreadId: null,
          preview: "",
          ephemeral: true,
          historyMode: "legacy",
          modelProvider: "policy_probe",
          createdAt: 1788874560,
          updatedAt: 1788874560,
          recencyAt: 1788874560,
          status: {
            type: "idle",
          },
          path: null,
          cwd: "C:\\Users\\moooyo\\AppData\\Local\\Temp\\m32-interactive-metadata-lXTZoE\\workspace",
          cliVersion: "0.145.0",
          source: "vscode",
          canAcceptDirectInput: true,
          threadSource: null,
          agentNickname: null,
          agentRole: null,
          gitInfo: null,
          name: null,
          turns: [],
        },
      },
      emittedAtMs: 1788874560044,
    },
    {
      method: "warning",
      params: {
        threadId: "01a0813b-9217-76b2-bb4c-de99eacdf534",
        message:
          "Model metadata for `synthetic-policy-probe` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.",
      },
      emittedAtMs: 1788874560068,
    },
    {
      method: "thread/status/changed",
      params: {
        threadId: "01a0813b-9217-76b2-bb4c-de99eacdf534",
        status: {
          type: "active",
          activeFlags: [],
        },
      },
      emittedAtMs: 1788874560068,
    },
    {
      method: "turn/started",
      params: {
        threadId: "01a0813b-9217-76b2-bb4c-de99eacdf534",
        turn: {
          id: "01a0813b-9233-7641-80bd-5ad7fc09218e",
          items: [],
          itemsView: "notLoaded",
          status: "inProgress",
          error: null,
          startedAt: 1788874560,
          completedAt: null,
          durationMs: null,
        },
      },
      emittedAtMs: 1788874560068,
    },
    {
      method: "rawResponseItem/completed",
      params: {
        threadId: "01a0813b-9217-76b2-bb4c-de99eacdf534",
        turnId: "01a0813b-9233-7641-80bd-5ad7fc09218e",
        item: {
          type: "message",
          role: "developer",
          content: [
            {
              type: "input_text",
              text: "<permissions instructions>\nFilesystem sandboxing defines which files can be read or written. `sandbox_mode` is `read-only`: The sandbox only permits reading files. Network access is enabled.\nApproval policy is currently never. Do not provide the `sandbox_permissions` for any reason, commands will be rejected.\r\n</permissions instructions>",
            },
            {
              type: "input_text",
              text: "<skills_instructions>\n## Skills\nA skill is a set of instructions provided through a `SKILL.md` source. Below is the list of skills that can be used. Each entry includes a name, description, and source locator. `file` locators are on the host filesystem, `environment resource` locators are owned by an execution environment, `orchestrator resource` locators are opaque non-filesystem resources, and `custom resource` locators use their provider's access mechanism.\n### Available skills\n- imagegen: Generate or edit raster images when the task benefits from AI-created bitmap visuals such as photos, illustrations, textures, sprites, mockups, or transparent-background cutouts. Use when Codex should create a brand-new image, transform an existing image, or derive visual variants from references, and the output should be a bitmap asset rather than repo-native code or vector. Do not use when the task is better handled by editing existing SVG/vector/code-native assets, extending an established icon or logo system, or building the visual directly in HTML/CSS/canvas. (file: C:/Users/moooyo/AppData/Local/Temp/m32-interactive-metadata-lXTZoE/home/.codex/skills/.system/imagegen/SKILL.md)\n- openai-docs: Use when the user asks how to build with OpenAI products or APIs, asks about Codex itself or choosing Codex surfaces, needs up-to-date official documentation with citations, help choosing the latest model for a use case, latest/current/default-model prompting guidance, or model upgrade and prompt-upgrade guidance; use OpenAI docs MCP tools for non-Codex docs questions, use the Codex manual helper first for broad Codex self-knowledge, and restrict fallback browsing to official OpenAI domains. (file: C:/Users/moooyo/AppData/Local/Temp/m32-interactive-metadata-lXTZoE/home/.codex/skills/.system/openai-docs/SKILL.md)\n- plugin-creator: Create and scaffold plugin directories for Codex with a required `.codex-plugin/plugin.json`, optional plugin folders/files, valid manifest defaults, and personal-marketplace entries by default. Use when Codex needs to create a new personal plugin, add optional plugin structure, generate or update marketplace entries for plugin ordering and availability metadata, or update an existing local plugin during development with the CLI-driven cachebuster and reinstall flow. (file: C:/Users/moooyo/AppData/Local/Temp/m32-interactive-metadata-lXTZoE/home/.codex/skills/.system/plugin-creator/SKILL.md)\n- skill-creator: Guide for creating effective skills. This skill should be used when users want to create a new skill (or update an existing skill) that extends Codex's capabilities with specialized knowledge, workflows, or tool integrations. (file: C:/Users/moooyo/AppData/Local/Temp/m32-interactive-metadata-lXTZoE/home/.codex/skills/.system/skill-creator/SKILL.md)\n- skill-installer: Install Codex skills into $CODEX_HOME/skills from a curated list or a GitHub repo path. Use when a user asks to list installable skills, install a curated skill, or install a skill from another repo (including private repos). (file: C:/Users/moooyo/AppData/Local/Temp/m32-interactive-metadata-lXTZoE/home/.codex/skills/.system/skill-installer/SKILL.md)\n</skills_instructions>",
            },
          ],
          internal_chat_message_metadata_passthrough: {
            turn_id: "01a0813b-9233-7641-80bd-5ad7fc09218e",
          },
        },
      },
      emittedAtMs: 1788874560068,
    },
    {
      method: "rawResponseItem/completed",
      params: {
        threadId: "01a0813b-9217-76b2-bb4c-de99eacdf534",
        turnId: "01a0813b-9233-7641-80bd-5ad7fc09218e",
        item: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: '<environment_context>\n  <cwd>C:\\Users\\moooyo\\AppData\\Local\\Temp\\m32-interactive-metadata-lXTZoE\\workspace</cwd>\n  <shell>powershell</shell>\n  <current_date>2026-09-08</current_date>\n  <timezone>Asia/Shanghai</timezone>\n  <filesystem><workspace_roots><root>C:\\Users\\moooyo\\AppData\\Local\\Temp\\m32-interactive-metadata-lXTZoE\\workspace</root></workspace_roots><permission_profile type="managed"><file_system type="restricted"><entry access="read"><special>:minimal</special></entry><entry access="read"><path>C:\\Users\\moooyo\\AppData\\Local\\Temp\\m32-interactive-metadata-lXTZoE\\workspace</path></entry></file_system></permission_profile></filesystem>\n</environment_context>',
            },
          ],
          internal_chat_message_metadata_passthrough: {
            turn_id: "01a0813b-9233-7641-80bd-5ad7fc09218e",
          },
        },
      },
      emittedAtMs: 1788874560068,
    },
    {
      method: "rawResponseItem/completed",
      params: {
        threadId: "01a0813b-9217-76b2-bb4c-de99eacdf534",
        turnId: "01a0813b-9233-7641-80bd-5ad7fc09218e",
        item: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: "This is owned synthetic app-server protocol sample 04757ef4-c558-41a2-9304-fbd7ce8d2fa3. Do not invoke any tool, read any file, or request sandbox setup. Return only the supplied strict JSON final answer. This does not test actual model execution or command/network isolation.",
            },
          ],
          internal_chat_message_metadata_passthrough: {
            turn_id: "01a0813b-9233-7641-80bd-5ad7fc09218e",
          },
        },
      },
      emittedAtMs: 1788874560069,
    },
    {
      method: "item/started",
      params: {
        item: {
          type: "userMessage",
          id: "01a0813b-9245-7ba0-a8dc-d74ba3e742da",
          clientId: null,
          content: [
            {
              type: "text",
              text: "This is owned synthetic app-server protocol sample 04757ef4-c558-41a2-9304-fbd7ce8d2fa3. Do not invoke any tool, read any file, or request sandbox setup. Return only the supplied strict JSON final answer. This does not test actual model execution or command/network isolation.",
              text_elements: [],
            },
          ],
        },
        threadId: "01a0813b-9217-76b2-bb4c-de99eacdf534",
        turnId: "01a0813b-9233-7641-80bd-5ad7fc09218e",
        startedAtMs: 1788874560069,
      },
      emittedAtMs: 1788874560069,
    },
    {
      method: "item/completed",
      params: {
        item: {
          type: "userMessage",
          id: "01a0813b-9245-7ba0-a8dc-d74ba3e742da",
          clientId: null,
          content: [
            {
              type: "text",
              text: "This is owned synthetic app-server protocol sample 04757ef4-c558-41a2-9304-fbd7ce8d2fa3. Do not invoke any tool, read any file, or request sandbox setup. Return only the supplied strict JSON final answer. This does not test actual model execution or command/network isolation.",
              text_elements: [],
            },
          ],
        },
        threadId: "01a0813b-9217-76b2-bb4c-de99eacdf534",
        turnId: "01a0813b-9233-7641-80bd-5ad7fc09218e",
        completedAtMs: 1788874560069,
      },
      emittedAtMs: 1788874560069,
    },
    {
      method: "item/started",
      params: {
        item: {
          type: "agentMessage",
          id: "msg_04757ef4-c558-41a2-9304-fbd7ce8d2fa3",
          text: "",
          phase: null,
          memoryCitation: null,
        },
        threadId: "01a0813b-9217-76b2-bb4c-de99eacdf534",
        turnId: "01a0813b-9233-7641-80bd-5ad7fc09218e",
        startedAtMs: 1788874560111,
      },
      emittedAtMs: 1788874560111,
    },
    {
      method: "item/agentMessage/delta",
      params: {
        threadId: "01a0813b-9217-76b2-bb4c-de99eacdf534",
        turnId: "01a0813b-9233-7641-80bd-5ad7fc09218e",
        itemId: "msg_04757ef4-c558-41a2-9304-fbd7ce8d2fa3",
        delta:
          '{"schemaVersion":"SyntheticAppServerTurnV1","probeId":"04757ef4-c558-41a2-9304-fbd7ce8d2fa3","synthetic":true,"toolCallsIssued":0}',
      },
      emittedAtMs: 1788874560111,
    },
    {
      method: "item/completed",
      params: {
        item: {
          type: "agentMessage",
          id: "msg_04757ef4-c558-41a2-9304-fbd7ce8d2fa3",
          text: '{"schemaVersion":"SyntheticAppServerTurnV1","probeId":"04757ef4-c558-41a2-9304-fbd7ce8d2fa3","synthetic":true,"toolCallsIssued":0}',
          phase: null,
          memoryCitation: null,
        },
        threadId: "01a0813b-9217-76b2-bb4c-de99eacdf534",
        turnId: "01a0813b-9233-7641-80bd-5ad7fc09218e",
        completedAtMs: 1788874560111,
      },
      emittedAtMs: 1788874560111,
    },
    {
      method: "rawResponseItem/completed",
      params: {
        threadId: "01a0813b-9217-76b2-bb4c-de99eacdf534",
        turnId: "01a0813b-9233-7641-80bd-5ad7fc09218e",
        item: {
          type: "message",
          id: "msg_04757ef4-c558-41a2-9304-fbd7ce8d2fa3",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: '{"schemaVersion":"SyntheticAppServerTurnV1","probeId":"04757ef4-c558-41a2-9304-fbd7ce8d2fa3","synthetic":true,"toolCallsIssued":0}',
            },
          ],
          internal_chat_message_metadata_passthrough: {
            turn_id: "01a0813b-9233-7641-80bd-5ad7fc09218e",
          },
        },
      },
      emittedAtMs: 1788874560111,
    },
    {
      method: "rawResponse/completed",
      params: {
        threadId: "01a0813b-9217-76b2-bb4c-de99eacdf534",
        turnId: "01a0813b-9233-7641-80bd-5ad7fc09218e",
        responseId: "resp_04757ef4-c558-41a2-9304-fbd7ce8d2fa3",
        usage: {
          totalTokens: 2,
          inputTokens: 1,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          outputTokens: 1,
          reasoningOutputTokens: 0,
        },
      },
      emittedAtMs: 1788874560111,
    },
    {
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "01a0813b-9217-76b2-bb4c-de99eacdf534",
        turnId: "01a0813b-9233-7641-80bd-5ad7fc09218e",
        tokenUsage: {
          total: {
            totalTokens: 2,
            inputTokens: 1,
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
            outputTokens: 1,
            reasoningOutputTokens: 0,
          },
          last: {
            totalTokens: 2,
            inputTokens: 1,
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
            outputTokens: 1,
            reasoningOutputTokens: 0,
          },
          modelContextWindow: 258400,
        },
      },
      emittedAtMs: 1788874560111,
    },
    {
      method: "account/rateLimits/updated",
      params: {
        rateLimits: {
          limitId: "codex",
          limitName: null,
          primary: null,
          secondary: null,
          credits: null,
          individualLimit: null,
          spendControlReached: null,
          planType: null,
          rateLimitReachedType: null,
        },
      },
      emittedAtMs: 1788874560111,
    },
    {
      method: "thread/status/changed",
      params: {
        threadId: "01a0813b-9217-76b2-bb4c-de99eacdf534",
        status: {
          type: "idle",
        },
      },
      emittedAtMs: 1788874560111,
    },
    {
      method: "turn/completed",
      params: {
        threadId: "01a0813b-9217-76b2-bb4c-de99eacdf534",
        turn: {
          id: "01a0813b-9233-7641-80bd-5ad7fc09218e",
          items: [],
          itemsView: "notLoaded",
          status: "completed",
          error: null,
          startedAt: 1788874560,
          completedAt: 1788874560,
          durationMs: 43,
        },
      },
      emittedAtMs: 1788874560111,
    },
  ],
} as const;
