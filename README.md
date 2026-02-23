# AI Features Showcase (Zulip)

## 项目目标
这个展示包包含我在 Zulip 代码中实现的两项 AI 功能：

1. 自动总结未读消息（Unread Recap）
2. 根据频道讨论内容自动建议更新频道标题（Topic Title Improver）

目标是提升信息检索效率与频道可读性，同时控制模型调用成本和交互延迟。

## 我的实现思路

### 1) 未读消息自动总结
- 前端在 Inbox 视图挂载 `Unread recap` 入口，点击后收集未读消息 ID 并请求后端。
- 后端按前端顺序拉取消息内容，调用 LLM 生成 HTML 摘要。
- 响应同时返回消息引用（message id + anchor + snippet），用户可以从总结直接跳回原消息。
- 对输入规模做边界控制（最多 200 条），避免超大请求。
- LLM 失败或未配置 API key 时，使用可读的 fallback 内容，保证功能可用。

### 2) 频道标题自动更新建议
- 在 stream 消息发送成功后，前端将 message id 做小批量聚合（默认 3 条触发一次）。
- 触发前增加本地去重与节流：
  - cooldown 防止短时间重复请求
  - 与历史建议做相似度比较，抑制重复建议
- 后端先执行轻量启发式判断（消息条数、平均长度、与当前标题匹配率），只有疑似“话题漂移”才调用 LLM。
- 返回建议标题后，前端显示非阻塞浮层，用户可 `Apply` 或 `Dismiss`。
- `Apply` 时通过消息编辑接口对整个 topic 执行 `change_all`，实现整段会话标题统一更新。

## 技术亮点
- 成本控制：批量触发 + 冷却时间 + 服务端 heuristics，减少无效 LLM 请求。
- 鲁棒性：前后端均有降级路径（API key 缺失/接口失败时功能不崩）。
- 安全性：总结结果经过 HTML 清洗（bleach）后再渲染。
- 工程化落地：从发送链路到后端路由、再到 UI 交互闭环，形成可直接上线的完整 feature。

## 目录说明
- `frontend/recap.ts`：未读总结入口与展示 UI
- `frontend/topic_improver.ts`：标题建议触发、去重节流、浮层与应用动作
- `backend/message_recap.py`：未读总结接口
- `backend/topic_improver.py`：标题建议接口与启发式过滤
- `backend/ai.py`：LLM 调用与降级逻辑（总结 + 标题建议）
- `backend/urls.py`：相关 API 路由
