export type ImportedTaskReference = {
  href: string;
  name: string;
};

export const importedTaskReferenceSymbol = Symbol.for(
  "knitting.importTask.reference",
);

type ImportedTaskPlaceholder = ((...args: unknown[]) => never) & {
  [importedTaskReferenceSymbol]: ImportedTaskReference;
};

export const createImportedTaskPlaceholder = <T>(
  href: string,
  name: string,
): T => {
  const placeholder = ((..._args: unknown[]) => {
    throw new Error(
      `importTask placeholder for "${name}" from "${href}" cannot be called directly. ` +
        "Pass the task definition to createPool() and invoke it through pool.call.",
    );
  }) as ImportedTaskPlaceholder;

  placeholder[importedTaskReferenceSymbol] = { href, name };
  return placeholder as unknown as T;
};

export const getImportedTaskReference = (
  value: unknown,
): ImportedTaskReference | undefined => {
  if (typeof value !== "function") return undefined;

  return (value as Partial<ImportedTaskPlaceholder>)[importedTaskReferenceSymbol];
};
