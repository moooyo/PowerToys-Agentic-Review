import type { Static } from "@sinclair/typebox";
import type {
  ManagedRepository,
  ManagedRepositorySummary,
  ManagedRepositorySummarySchema,
  PromptTemplate,
  PromptTemplateSummary,
  PromptTemplateSummarySchema,
  PromptVersion,
  PromptVersionSummary,
  PromptVersionSummarySchema,
  UiScenarioConfiguration,
  UiScenarioStep,
  ValidationProfileVersion,
  ValidationProfileVersionSummary,
  ValidationProfileVersionSummarySchema,
  WebUiConfiguration,
  WindowsUiConfiguration,
} from "../dist/index.js";

export function uiScenarioFields(ui: UiScenarioConfiguration): string[] {
  const targetDetail = ui.target === "web" ? ui.service.portEnvironmentVariable : ui.desktop.scope;
  return [targetDetail, ...ui.scenarios.map((scenario) => `${scenario.id}:${scenario.required}`)];
}

export function uiTargetSpecificFields(
  web: WebUiConfiguration,
  windows: WindowsUiConfiguration,
): string[] {
  return [web.launch.readiness.path, windows.launch.readiness.window.title ?? ""];
}

export function uiAssertionExpectedValue(step: UiScenarioStep): string | boolean | undefined {
  if (
    step.action === "assertVisible" ||
    step.action === "assertText" ||
    step.action === "assertValue"
  ) {
    return step.expected;
  }
  // @ts-expect-error Configuration actions never carry driver-produced actual values.
  void step.actual;
  return undefined;
}

// Compile against emitted declarations so successful runtime validation cannot conceal a `never`
// static type in a package consumer. Run after building the contracts package.
export function repositorySummaryFields(items: ManagedRepositorySummary[]): string[] {
  return items.map((item) => `${item.id}:${item.fullName}:${item.version}`);
}

export function promptTemplateSummaryFields(items: PromptTemplateSummary[]): string[] {
  return items.map((item) => `${item.id}:${item.workflowKind}:${item.draftRevision}`);
}

export function promptVersionSummaryFields(items: PromptVersionSummary[]): string[] {
  return items.map((item) => `${item.id}:${item.templateId}:${item.contentSha256}`);
}

export function profileVersionSummaryFields(items: ValidationProfileVersionSummary[]): string[] {
  return items.map((item) => `${item.id}:${item.profileId}:${item.target}:${item.configSha256}`);
}

export function schemaStaticFields(
  repository: Static<typeof ManagedRepositorySummarySchema>,
  template: Static<typeof PromptTemplateSummarySchema>,
  promptVersion: Static<typeof PromptVersionSummarySchema>,
  profile: Static<typeof ValidationProfileVersionSummarySchema>,
): string[] {
  return [repository.id, template.id, promptVersion.id, profile.id];
}

export function detailOnlyFields(
  repository: ManagedRepository,
  template: PromptTemplate,
  promptVersion: PromptVersion,
  profile: ValidationProfileVersion,
): unknown[] {
  return [
    repository.authorizationPolicy,
    template.draftContent,
    promptVersion.content,
    profile.config,
  ];
}

export function rejectDetailFieldsOnSummaries(
  repository: ManagedRepositorySummary,
  template: PromptTemplateSummary,
  promptVersion: PromptVersionSummary,
  profile: ValidationProfileVersionSummary,
): void {
  // @ts-expect-error List summaries exclude repository authorization policy.
  void repository.authorizationPolicy;
  // @ts-expect-error List summaries exclude prompt draft content.
  void template.draftContent;
  // @ts-expect-error List summaries exclude published prompt content.
  void promptVersion.content;
  // @ts-expect-error List summaries exclude validation execution configuration.
  void profile.config;
}
