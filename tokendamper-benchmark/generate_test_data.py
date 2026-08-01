import os
import tiktoken

tokenizer = tiktoken.get_encoding("cl100k_base")

os.makedirs("test_data", exist_ok=True)

# 1. sample_logs.txt (~3,500 tokens)
# Must contain repeated debug lines and buried secret Key: "BLUE-PANDA-992"

log_lines = []
for i in range(1, 16):
    log_lines.append(f"2026-07-30T19:00:{i%60:02d}.{i*12%1000:03d}Z [DEBUG] com.service.worker.TaskWorker - Task-{i:04d}: Executing background maintenance routine cycle {i}. CPU usage: {15.2 + (i%10)*0.5}%. Memory: 412MB.")
    log_lines.append(f"2026-07-30T19:00:{i%60:02d}.{i*12%1000:03d}Z [INFO]  com.service.db.ConnectionPool - Connection acquired from pool 'primary_read_replica'. Active: 14/50, Idle: 36/50.")
    log_lines.append(f"2026-07-30T19:00:{i%60:02d}.{i*12%1000:03d}Z [DEBUG] com.service.cache.RedisAdapter - Cache GET key 'user:session:tok_{i*7}' returned HIT (ttl=1742s).")

    if i == 12:
        log_lines.append("2026-07-30T19:00:45.999Z [CRITICAL] com.service.auth.VaultManager - Secret Key: \"BLUE-PANDA-992\" loaded into secure memory vault.")

    log_lines.append(f"2026-07-30T19:00:{i%60:02d}.{i*12%1000:03d}Z [WARN]  com.service.gateway.RateLimiter - Bucket 'api_v2_tier3' token count low: 18/100 remaining for IP 10.240.12.{i%255}.")
    log_lines.append(f"2026-07-30T19:00:{i%60:02d}.{i*12%1000:03d}Z [DEBUG] com.service.telemetry.MetricsExporter - Exported 48 metrics to Prometheus endpoint /metrics in {4.2 + (i%5)*0.3}ms.")

sample_logs_content = "\n".join(log_lines)

with open("test_data/sample_logs.txt", "w", encoding="utf-8") as f:
    f.write(sample_logs_content)

# 2. tool_output.json (~3,500 tokens)
# A large JSON payload representing API/tool responses

items = []
for i in range(1, 12):
    items.append({
        "id": f"res-srv-{i:05d}",
        "name": f"production-worker-node-{i}",
        "status": "ACTIVE" if i % 7 != 0 else "DEGRADED",
        "region": "us-east-1" if i % 2 == 0 else "us-west-2",
        "instanceType": "c6i.4xlarge" if i % 3 == 0 else "m6i.2xlarge",
        "ipAddress": f"10.100.14.{i}",
        "tags": {
            "environment": "production",
            "team": "infrastructure-core",
            "cost_center": "CC-90412",
            "managed_by": "terraform-provider-aws-v5.12.0"
        },
        "metrics": {
            "cpu_utilization_avg_5m": round(20.5 + (i * 1.7) % 65, 2),
            "memory_utilization_bytes": 16485760000 + i * 10485760,
            "disk_io_ps": 1250 + (i * 35) % 800,
            "network_in_bytes_per_sec": 45000000 + i * 120000,
            "network_out_bytes_per_sec": 89000000 + i * 230000
        },
        "health_checks": [
            {"check_name": "http_ping", "status": "PASS", "latency_ms": 1.2 + (i % 3)},
            {"check_name": "disk_space", "status": "PASS", "free_percent": 68.4},
            {"check_name": "systemd_services", "status": "PASS" if i % 7 != 0 else "WARN", "failed_units": [] if i % 7 != 0 else ["logrotate.service"]}
        ]
    })

import json
tool_output_json = json.dumps({
    "apiVersion": "v2.4.0",
    "timestamp": "2026-07-30T19:30:00Z",
    "responseMetadata": {
        "requestId": "req-99481204-af81-4b11-912c-0029418512fa",
        "httpStatusCode": 200,
        "totalRecords": len(items),
        "pageSize": 50,
        "pageIndex": 1,
        "hasMorePages": False
    },
    "data": items
}, indent=2)

with open("test_data/tool_output.json", "w", encoding="utf-8") as f:
    f.write(tool_output_json)

# 3. codebase.py (~3,500 tokens)
# A long Python source code file with realistic utility functions, classes, docstrings, helper methods.

codebase_lines = [
    '"""',
    'Distributed Data Pipeline & Resilience Engine for TokenDamper',
    'Provides fault-tolerant stream processing, caching adapters, circuit breaking,',
    'and asynchronous task scheduling across microservices.',
    '"""',
    '',
    'import asyncio',
    'import logging',
    'import time',
    'import uuid',
    'from dataclasses import dataclass, field',
    'from typing import Any, Dict, List, Optional, Tuple, Callable',
    '',
    'logger = logging.getLogger("tokendamper.resilience")',
    '',
    '@dataclass',
    'class PipelineMetric:',
    '    """Data model representing execution metrics for a pipeline stage."""',
    '    stage_name: str',
    '    execution_time_ms: float',
    '    items_processed: int',
    '    errors_encountered: int = 0',
    '    timestamp: float = field(default_factory=time.time)',
    '    metadata: Dict[str, Any] = field(default_factory=dict)',
    '',
    'class CircuitBreakerOpenException(Exception):',
    '    """Raised when an operation is attempted while the circuit breaker is OPEN."""',
    '    pass',
    '',
    'class CircuitBreaker:',
    '    """',
    '    Implements state machine for circuit breaker pattern (CLOSED, OPEN, HALF_OPEN).',
    '    Tracks failure counts and automatically handles state transitions.',
    '    """',
    '    def __init__(self, failure_threshold: int = 5, recovery_timeout: float = 30.0):',
    '        self.failure_threshold = failure_threshold',
    '        self.recovery_timeout = recovery_timeout',
    '        self.failure_count = 0',
    '        self.state = "CLOSED"',
    '        self.last_state_change = time.time()',
    '',
    '    def record_success(self) -> None:',
    '        """Records a successful operation call and resets failure counters."""',
    '        self.failure_count = 0',
    '        if self.state != "CLOSED":',
    '            logger.info("CircuitBreaker transitioned to CLOSED state")',
    '            self.state = "CLOSED"',
    '            self.last_state_change = time.time()',
    '',
    '    def record_failure(self) -> None:',
    '        """Records a failed operation call and increments failure counter."""',
    '        self.failure_count += 1',
    '        if self.failure_count >= self.failure_threshold:',
    '            if self.state != "OPEN":',
    '                logger.warning(f"CircuitBreaker threshold reached ({self.failure_count}). Transitioning to OPEN state")',
    '                self.state = "OPEN"',
    '                self.last_state_change = time.time()',
    '',
    '    def allow_execution(self) -> bool:',
    '        """Checks whether an operation execution should be permitted."""',
    '        if self.state == "CLOSED":',
    '            return True',
    '        if self.state == "OPEN":',
    '            if time.time() - self.last_state_change > self.recovery_timeout:',
    '                logger.info("CircuitBreaker recovery timeout elapsed. Transitioning to HALF_OPEN state")',
    '                self.state = "HALF_OPEN"',
    '                self.last_state_change = time.time()',
    '                return True',
    '            return False',
    '        if self.state == "HALF_OPEN":',
    '            return True',
    '        return False',
    ''
]

for stage_id in range(1, 6):
    codebase_lines.extend([
        f'class DataPipelineStage{stage_id}:',
        f'    """Processing pipeline stage {stage_id} responsible for batch transformations."""',
        f'    def __init__(self, name: str = "stage_{stage_id}", max_retries: int = 3):',
        f'        self.name = name',
        f'        self.max_retries = max_retries',
        f'        self.circuit_breaker = CircuitBreaker(failure_threshold=5, recovery_timeout=15.0)',
        f'        self.metrics_history: List[PipelineMetric] = []',
        f'',
        f'    async def process_batch(self, batch_items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:',
        f'        """Process a list of input records through stage {stage_id} with retry logic."""',
        f'        if not self.circuit_breaker.allow_execution():',
        f'            raise CircuitBreakerOpenException(f"Stage {{self.name}} circuit breaker is OPEN")',
        f'',
        f'        start_time = time.perf_counter()',
        f'        processed_records = []',
        f'        error_count = 0',
        f'',
        f'        for item in batch_items:',
        f'            try:',
        f'                transformed = self.transform_item(item)',
        f'                processed_records.append(transformed)',
        f'            except Exception as exc:',
        f'                error_count += 1',
        f'                logger.error(f"Error processing item {{item.get(\'id\')}} in stage {{self.name}}: {{exc}}")',
        f'',
        f'        duration = (time.perf_counter() - start_time) * 1000.0',
        f'        metric = PipelineMetric(',
        f'            stage_name=self.name,',
        f'            execution_time_ms=duration,',
        f'            items_processed=len(processed_records),',
        f'            errors_encountered=error_count,',
        f'            metadata={{"stage_id": {stage_id}, "input_count": len(batch_items)}}',
        f'        )',
        f'        self.metrics_history.append(metric)',
        f'',
        f'        if error_count > len(batch_items) // 2:',
        f'            self.circuit_breaker.record_failure()',
        f'        else:',
        f'            self.circuit_breaker.record_success()',
        f'',
        f'        return processed_records',
        f'',
        f'    def transform_item(self, item: Dict[str, Any]) -> Dict[str, Any]:',
        f'        """Applies stage-{stage_id} domain transformation to a single item dict."""',
        f'        res = dict(item)',
        f'        res["processed_by_stage_{stage_id}"] = True',
        f'        res["stage_{stage_id}_timestamp"] = time.time()',
        f'        res["stage_{stage_id}_hash"] = hash(str(item))',
        f'        return res',
        f'',
        f'    def get_summary_statistics(self) -> Dict[str, Any]:',
        f'        """Calculates aggregated performance statistics across all historical batches."""',
        f'        if not self.metrics_history:',
        f'            return {{"total_batches": 0, "avg_time_ms": 0.0, "total_items": 0}}',
        f'        total_time = sum(m.execution_time_ms for m in self.metrics_history)',
        f'        total_items = sum(m.items_processed for m in self.metrics_history)',
        f'        return {{',
        f'            "stage_name": self.name,',
        f'            "total_batches": len(self.metrics_history),',
        f'            "avg_time_ms": total_time / len(self.metrics_history),',
        f'            "total_items_processed": total_items,',
        f'            "circuit_state": self.circuit_breaker.state,',
        f'        }}',
        f''
    ])

codebase_content = "\n".join(codebase_lines)

with open("test_data/codebase.py", "w", encoding="utf-8") as f:
    f.write(codebase_content)

print("Generated test data files. Token counts:")
for fname in ["sample_logs.txt", "tool_output.json", "codebase.py"]:
    fpath = os.path.join("test_data", fname)
    with open(fpath, "r", encoding="utf-8") as f:
        text = f.read()
    tokens = len(tokenizer.encode(text))
    print(f"  {fname}: {len(text)} chars | {tokens} tokens")
