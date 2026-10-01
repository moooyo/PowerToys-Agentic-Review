import type { AutoReplyTemplateKey } from "../investigation/auto-reply-settings-form";

/** Canonical static publication defaults, matching the server's version 4 templates. */
export const defaultReplyTemplates: Readonly<Record<AutoReplyTemplateKey, string>> = {
  pullRequest:
    "{{identity}}\n\n## Conclusion\n\n{{conclusion}}\n\n## Summary\n\n{{summary}}\n\n## Findings\n\n{{findings}}\n\n{{details}}\n",
  issue:
    "{{identity}}\n\n## Triage result\n\n{{conclusion}}\n\n## Next steps\n\n{{next_steps}}\n\n{{details}}\n",
  received:
    "## {{status}}\n\n{{trigger}}\n\nThe request has been received for investigation. This comment will track its progress.\n\nLast updated: {{updated_at}}\n",
  started:
    "## {{status}}\n\n{{trigger}}\n\nWork has started. This comment will be updated with the outcome.\n\nLast updated: {{updated_at}}\n",
  failed: "## {{status}}\n\n{{trigger}}\n\nLast updated: {{updated_at}}\n\n{{failure}}\n",
  completed: "## {{status}}\n\n{{trigger}}\n\nLast updated: {{updated_at}}\n\n{{result}}\n",
};
