import {
  BaseCheckpointSaver,
  type Checkpoint,
  type CheckpointMetadata,
  type CheckpointTuple,
} from '@langchain/langgraph'
import type { AgentScope } from '@nexus/plugin-sdk/agent'
import { AgentFailure } from '../errors.js'
import type { AgentHost } from '../host.js'

type Config = Parameters<BaseCheckpointSaver['getTuple']>[0]
type ListOptions = Parameters<BaseCheckpointSaver['list']>[1]
type Versions = Parameters<BaseCheckpointSaver['put']>[3]
type Writes = Parameters<BaseCheckpointSaver['putWrites']>[1]

function serializable(value: unknown): unknown {
  const encoded = JSON.stringify(value)
  if (encoded === undefined || Buffer.byteLength(encoded) > 512 * 1024)
    throw new AgentFailure('INVALID_REQUEST', '工作流检查点超过大小上限')
  return JSON.parse(encoded) as unknown
}

function configFor(config: Config, threadId: string): Config {
  const suppliedThread = config.configurable?.thread_id
  const namespace: unknown = config.configurable?.checkpoint_ns ?? ''
  const checkpointId: unknown = config.configurable?.checkpoint_id
  if (
    suppliedThread !== threadId ||
    typeof namespace !== 'string' ||
    namespace.length > 200 ||
    (checkpointId !== undefined && typeof checkpointId !== 'string')
  )
    throw new AgentFailure('PERMISSION_DENIED', '工作流检查点不属于当前任务')
  return {
    configurable: {
      thread_id: threadId,
      checkpoint_ns: namespace,
      ...(checkpointId === undefined ? {} : { checkpoint_id: checkpointId }),
    },
  }
}

export class HostCheckpointer extends BaseCheckpointSaver {
  constructor(
    private readonly host: AgentHost,
    private readonly scope: AgentScope,
    private readonly signal?: AbortSignal,
  ) {
    super()
  }

  private keys(config: Config) {
    const validated = configFor(config, this.scope.jobId)
    return {
      threadId: this.scope.jobId,
      checkpointNs: validated.configurable?.checkpoint_ns ?? '',
      ...(validated.configurable?.checkpoint_id === undefined
        ? {}
        : {
            checkpointId: validated.configurable.checkpoint_id,
          }),
    }
  }

  async getTuple(config: Config): Promise<CheckpointTuple | undefined> {
    const result = await this.host.call<CheckpointTuple | null>(
      this.scope,
      'agent.checkpoint.get',
      this.keys(config),
      this.signal,
    )
    if (result === null) return undefined
    this.validateTuple(result)
    return result
  }

  async *list(config: Config, options?: ListOptions): AsyncGenerator<CheckpointTuple> {
    const result = await this.host.call<CheckpointTuple[]>(
      this.scope,
      'agent.checkpoint.list',
      {
        ...this.keys(config),
        limit: Math.min(options?.limit ?? 50, 50),
        ...(options?.before
          ? {
              before: configFor(options.before, this.scope.jobId),
            }
          : {}),
        ...(options?.filter ? { filter: serializable(options.filter) } : {}),
      },
      this.signal,
    )
    if (!Array.isArray(result) || result.length > 50)
      throw new AgentFailure('PROTOCOL_ERROR', '工作流检查点列表格式无效')
    for (const tuple of result) {
      this.validateTuple(tuple)
      yield tuple
    }
  }

  async put(
    config: Config,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    newVersions: Versions,
  ): Promise<Config> {
    const result = await this.host.call<Config>(
      this.scope,
      'agent.checkpoint.put',
      {
        ...this.keys(config),
        checkpoint: serializable(checkpoint),
        metadata: serializable(metadata),
        newVersions: serializable(newVersions),
        parentConfig: configFor(config, this.scope.jobId),
      },
      this.signal,
    )
    return configFor(result, this.scope.jobId)
  }

  async putWrites(
    config: Config,
    writes: Writes,
    taskId: string,
    taskPath?: string,
  ): Promise<void> {
    await this.host.call(
      this.scope,
      'agent.checkpoint.putWrites',
      {
        ...this.keys(config),
        writes: serializable(writes),
        taskId,
        ...(taskPath === undefined ? {} : { taskPath }),
      },
      this.signal,
    )
  }

  async deleteThread(threadId: string): Promise<void> {
    if (threadId !== this.scope.jobId)
      throw new AgentFailure('PERMISSION_DENIED', '不能删除其他任务的检查点')
    await this.host.call(this.scope, 'agent.checkpoint.delete', { threadId }, this.signal)
  }

  private validateTuple(tuple: CheckpointTuple): void {
    configFor(tuple.config, this.scope.jobId)
    if (
      !tuple.checkpoint ||
      typeof tuple.checkpoint.id !== 'string' ||
      !Number.isInteger(tuple.checkpoint.v) ||
      typeof tuple.checkpoint.channel_values !== 'object' ||
      tuple.checkpoint.channel_values === null
    )
      throw new AgentFailure('PROTOCOL_ERROR', '工作流检查点格式无效')
    if (tuple.parentConfig) configFor(tuple.parentConfig, this.scope.jobId)
  }
}
