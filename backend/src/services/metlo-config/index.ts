import { QueryRunner } from "typeorm"
import {
  AuthenticationConfig,
  MetloConfigResp,
  UpdateMetloConfigParams,
} from "@common/types"
import { AppDataSource } from "data-source"
import { MetloConfig } from "models/metlo-config"
import { MetloContext } from "types"
import { createQB, getQB, insertValueBuilder } from "services/database/utils"
import jsyaml from "js-yaml"
import { decrypt, encrypt, generate_iv } from "utils/encryption"
import {
  HostMapping,
  HostMappingCompiled,
  MetloConfigType,
  PathBlockList,
  PathBlockListCompiled,
} from "./types"
import { validateMetloConfig } from "./validate"
import { populateAuthentication, populateBlockFields } from "./populate-tables"
import { NodeCache } from "utils/node-cache"

export const getMetloConfig = async (
  ctx: MetloContext,
): Promise<MetloConfigResp> => {
  const config = (await createQB(ctx)
    .from(MetloConfig, "config")
    .getRawOne()) as MetloConfig
  if (config && config.env) {
    const key = Buffer.from(process.env.ENCRYPTION_KEY, "base64")
    const iv = Buffer.from(config.envIV, "base64")
    const tag = Buffer.from(config.envTag, "base64")
    const decryptedEnv = decrypt(config.env, key, iv, tag)
    config.configString = jsyaml.dump({
      ...(jsyaml.load(config.configString) as object),
      globalTestEnv: JSON.parse(decryptedEnv),
    })
  }
  return config
}

export const getMetloConfigProcessed = async (
  ctx: MetloContext,
  queryRunner?: QueryRunner,
): Promise<MetloConfigType> => {
  const config: MetloConfig = queryRunner
    ? await getQB(ctx, queryRunner)
        .from(MetloConfig, "config")
        .limit(1)
        .getRawOne()
    : await createQB(ctx).from(MetloConfig, "config").limit(1).getRawOne()
  if (!config?.configString) {
    return {}
  }
  return jsyaml.load(config.configString) as MetloConfigType
}

const metloConfigCache = new NodeCache({ stdTTL: 60, checkperiod: 10 })

export const getMetloConfigProcessedCached = async (
  ctx: MetloContext,
  queryRunner?: QueryRunner,
): Promise<MetloConfigType> => {
  const cacheRes: MetloConfigType | undefined = metloConfigCache.get(
    ctx,
    "cachedMetloConfig",
  )
  if (cacheRes) {
    return cacheRes
  }
  const realRes = await getMetloConfigProcessed(ctx, queryRunner)
  metloConfigCache.set(ctx, "cachedMetloConfig", realRes)
  return realRes
}

export const getGlobalFullTraceCaptureCached = async (
  ctx: MetloContext,
): Promise<boolean> => {
  const conf = await getMetloConfigProcessedCached(ctx)
  return conf.globalFullTraceCapture ?? false
}

export const getHostMapCached = async (
  ctx: MetloContext,
  queryRunner?: QueryRunner,
): Promise<HostMapping[]> => {
  const conf = await getMetloConfigProcessedCached(ctx, queryRunner)
  return conf?.hostMap ?? []
}

export const getHostMapCompiledCached = async (
  ctx: MetloContext,
  queryRunner?: QueryRunner,
): Promise<HostMappingCompiled[]> => {
  const conf = await getMetloConfigProcessedCached(ctx, queryRunner)
  return (conf?.hostMap ?? []).map(e => ({
    host: e.host,
    pattern: new RegExp(e.pattern),
  }))
}

export const getHostBlockListCached = async (
  ctx: MetloContext,
  queryRunner?: QueryRunner,
): Promise<string[]> => {
  const conf = await getMetloConfigProcessedCached(ctx, queryRunner)
  return conf?.hostBlockList ?? []
}

export const getHostBlockListCompiledCached = async (
  ctx: MetloContext,
  queryRunner?: QueryRunner,
): Promise<RegExp[]> => {
  const conf = await getMetloConfigProcessedCached(ctx, queryRunner)
  return conf?.hostBlockList?.map(e => new RegExp(e)) ?? []
}

export const getPathBlockListCached = async (
  ctx: MetloContext,
  queryRunner?: QueryRunner,
): Promise<PathBlockList[]> => {
  const conf = await getMetloConfigProcessedCached(ctx, queryRunner)
  return conf?.pathBlockList ?? []
}

export const getPathBlockListCompiledCached = async (
  ctx: MetloContext,
  queryRunner?: QueryRunner,
): Promise<PathBlockListCompiled[]> => {
  const conf = await getMetloConfigProcessedCached(ctx, queryRunner)
  return (conf?.pathBlockList ?? []).map(e => ({
    host: new RegExp(e.host),
    paths: (e?.paths ?? []).map(path => new RegExp(path)),
  }))
}

export const getMinAnalyzeTracesCached = async (
  ctx: MetloContext,
): Promise<number> => {
  const conf = await getMetloConfigProcessedCached(ctx)
  return conf.minAnalyzeTraces ?? 100
}

export const getCustomWordsCached = async (
  ctx: MetloContext,
): Promise<Set<string>> => {
  const conf = await getMetloConfigProcessedCached(ctx)
  return new Set(conf.customWords || [])
}

export const getAuthenticationConfig = async (
  ctx: MetloContext,
): Promise<AuthenticationConfig[]> => {
  const conf = await getMetloConfigProcessedCached(ctx)
  return conf.authentication ?? []
}

export const updateMetloConfig = async (
  ctx: MetloContext,
  updateMetloConfigParams: UpdateMetloConfigParams,
) => {
  await populateMetloConfig(ctx, updateMetloConfigParams.configString)
}

const populateEnvironment = (metloConfig: object) => {
  const parsedConfigString = metloConfig
  if ("globalTestEnv" in parsedConfigString) {
    const key = Buffer.from(process.env.ENCRYPTION_KEY, "base64")
    const iv = generate_iv()
    const { encrypted, tag } = encrypt(
      JSON.stringify(parsedConfigString.globalTestEnv),
      key,
      iv,
    )
    delete parsedConfigString.globalTestEnv
    return {
      configString: jsyaml.dump(parsedConfigString),
      env: encrypted,
      envTag: tag.toString("base64"),
      envIV: iv.toString("base64"),
    }
  }
  return {
    configString: jsyaml.dump(parsedConfigString),
    env: "",
    envTag: "",
    envIV: "",
  }
}

export const populateMetloConfig = async (
  ctx: MetloContext,
  configString: string,
) => {
  const queryRunner = AppDataSource.createQueryRunner()
  try {
    await queryRunner.connect()
    const metloConfig = validateMetloConfig(configString)
    await queryRunner.startTransaction()
    await populateAuthentication(ctx, metloConfig, queryRunner)
    await populateBlockFields(ctx, metloConfig, queryRunner)
    const metloConfigEntry = await getQB(ctx, queryRunner)
      .select(["uuid"])
      .from(MetloConfig, "config")
      .getRawOne()
    if (metloConfigEntry) {
      const {
        configString: configStringNoEnv,
        env,
        envTag,
        envIV,
      } = populateEnvironment(metloConfig)
      await getQB(ctx, queryRunner)
        .update(MetloConfig)
        .set({ configString: configStringNoEnv, env, envTag, envIV })
        .execute()
    } else {
      const newConfig = MetloConfig.create()
      const {
        configString: configStringNoEnv,
        env,
        envTag,
        envIV,
      } = populateEnvironment(metloConfig)
      newConfig.configString = configStringNoEnv
      newConfig.env = env
      newConfig.envIV = envIV
      newConfig.envTag = envTag
      await insertValueBuilder(
        ctx,
        queryRunner,
        MetloConfig,
        newConfig,
      ).execute()
    }
    await queryRunner.commitTransaction()
  } catch (err) {
    if (queryRunner.isTransactionActive) {
      await queryRunner.rollbackTransaction()
    }
    throw err
  } finally {
    await queryRunner.release()
  }
}
