import { castOnSymbol } from "../common/caston-symbol.ts";
import { toModuleUrl } from "../common/module-url.ts";

type CastOnEntry = {
  readonly [castOnSymbol]: true;
  readonly at?: number;
  readonly f: () => unknown;
};

const isCastOnEntry = (value: unknown): value is CastOnEntry =>
  !!value &&
  typeof value === "object" &&
  typeof (value as { f?: unknown }).f === "function" &&
  (value as { [castOnSymbol]?: unknown })[castOnSymbol] === true;

export const executeCastOn = async ({
  castOnModule,
  castOnAt,
}: {
  castOnModule: string;
  castOnAt?: number;
}): Promise<void> => {
  const moduleUrl = toModuleUrl(castOnModule);
  const moduleNamespace = (await import(moduleUrl)) as Record<string, unknown>;
  const castOnEntries = Object.values(moduleNamespace).filter(isCastOnEntry);
  const castOnEntry = Number.isFinite(castOnAt)
    ? castOnEntries.find((entry) => entry.at === castOnAt)
    : castOnEntries[0];
  if (!castOnEntry) {
    throw new Error(
      `KNT_ERROR_CAST_ON_NOT_FOUND: no cast-on export found in ${moduleUrl}`,
    );
  }

  await Promise.resolve(castOnEntry.f());
};
