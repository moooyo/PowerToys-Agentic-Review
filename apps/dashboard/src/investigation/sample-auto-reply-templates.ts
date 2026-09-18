import type { RepositoryAutoReplyProgressTemplates } from "./api";

export const samplePullRequestAutoReplyTemplate = `{{identity}}

## Conclusion

{{conclusion}}

## Summary

{{summary}}

## Findings

{{findings}}

{{details}}
`;

export const sampleIssueAutoReplyTemplate = `{{identity}}

## Triage result

{{conclusion}}

## Next steps

{{next_steps}}

{{details}}
`;

export const sampleAutoReplyProgressTemplates: RepositoryAutoReplyProgressTemplates = {
  received: `## {{status}}

{{trigger}}

The assignment has been received for investigation. This comment will track its progress.

Last updated: {{updated_at}}
`,
  started: `## {{status}}

{{trigger}}

Work has started. This comment will be updated with the outcome.

Last updated: {{updated_at}}
`,
  failed: `## {{status}}

{{trigger}}

Last updated: {{updated_at}}

{{failure}}
`,
  completed: `## {{status}}

{{trigger}}

Last updated: {{updated_at}}

{{result}}
`,
};
