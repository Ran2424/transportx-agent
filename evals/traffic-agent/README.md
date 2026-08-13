# Traffic Agent Eval

`shanghai-v1.json` 是机器评测权威，包含原 25 道上海交通问答、3 道受控空间分析题和 3 个完整任务。Markdown 题库仍用于人工阅读，测试会校验前 25 题 ID 与数量。

真实评测不启动 Electron 或 React，而是由终端 runner 启动 Agent Host，通过生产 Session API、HTTP RPC、Pi、Module、Skill、Extension 和 Python 完成任务。

```bash
npm run eval:traffic -- --model provider/model --data-root /path/to/shanghai/database/assets
npm run eval:traffic -- --model provider/model --case SH-001 --keep-workspace
npm run eval:traffic:tasks -- --model provider/model --data-root /path/to/assets
```

真实模型与数据缺失时，`npm test` 只运行 suite parser、grader 和 fake result 测试，不会把真实 Eval 标记为已通过。
