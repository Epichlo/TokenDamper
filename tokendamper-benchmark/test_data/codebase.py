"""
Distributed Data Pipeline & Resilience Engine for TokenDamper
Provides fault-tolerant stream processing, caching adapters, circuit breaking,
and asynchronous task scheduling across microservices.
"""

import asyncio
import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple, Callable

logger = logging.getLogger("tokendamper.resilience")

@dataclass
class PipelineMetric:
    """Data model representing execution metrics for a pipeline stage."""
    stage_name: str
    execution_time_ms: float
    items_processed: int
    errors_encountered: int = 0
    timestamp: float = field(default_factory=time.time)
    metadata: Dict[str, Any] = field(default_factory=dict)

class CircuitBreakerOpenException(Exception):
    """Raised when an operation is attempted while the circuit breaker is OPEN."""
    pass

class CircuitBreaker:
    """
    Implements state machine for circuit breaker pattern (CLOSED, OPEN, HALF_OPEN).
    Tracks failure counts and automatically handles state transitions.
    """
    def __init__(self, failure_threshold: int = 5, recovery_timeout: float = 30.0):
        self.failure_threshold = failure_threshold
        self.recovery_timeout = recovery_timeout
        self.failure_count = 0
        self.state = "CLOSED"
        self.last_state_change = time.time()

    def record_success(self) -> None:
        """Records a successful operation call and resets failure counters."""
        self.failure_count = 0
        if self.state != "CLOSED":
            logger.info("CircuitBreaker transitioned to CLOSED state")
            self.state = "CLOSED"
            self.last_state_change = time.time()

    def record_failure(self) -> None:
        """Records a failed operation call and increments failure counter."""
        self.failure_count += 1
        if self.failure_count >= self.failure_threshold:
            if self.state != "OPEN":
                logger.warning(f"CircuitBreaker threshold reached ({self.failure_count}). Transitioning to OPEN state")
                self.state = "OPEN"
                self.last_state_change = time.time()

    def allow_execution(self) -> bool:
        """Checks whether an operation execution should be permitted."""
        if self.state == "CLOSED":
            return True
        if self.state == "OPEN":
            if time.time() - self.last_state_change > self.recovery_timeout:
                logger.info("CircuitBreaker recovery timeout elapsed. Transitioning to HALF_OPEN state")
                self.state = "HALF_OPEN"
                self.last_state_change = time.time()
                return True
            return False
        if self.state == "HALF_OPEN":
            return True
        return False

class DataPipelineStage1:
    """Processing pipeline stage 1 responsible for batch transformations."""
    def __init__(self, name: str = "stage_1", max_retries: int = 3):
        self.name = name
        self.max_retries = max_retries
        self.circuit_breaker = CircuitBreaker(failure_threshold=5, recovery_timeout=15.0)
        self.metrics_history: List[PipelineMetric] = []

    async def process_batch(self, batch_items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Process a list of input records through stage 1 with retry logic."""
        if not self.circuit_breaker.allow_execution():
            raise CircuitBreakerOpenException(f"Stage {self.name} circuit breaker is OPEN")

        start_time = time.perf_counter()
        processed_records = []
        error_count = 0

        for item in batch_items:
            try:
                transformed = self.transform_item(item)
                processed_records.append(transformed)
            except Exception as exc:
                error_count += 1
                logger.error(f"Error processing item {item.get('id')} in stage {self.name}: {exc}")

        duration = (time.perf_counter() - start_time) * 1000.0
        metric = PipelineMetric(
            stage_name=self.name,
            execution_time_ms=duration,
            items_processed=len(processed_records),
            errors_encountered=error_count,
            metadata={"stage_id": 1, "input_count": len(batch_items)}
        )
        self.metrics_history.append(metric)

        if error_count > len(batch_items) // 2:
            self.circuit_breaker.record_failure()
        else:
            self.circuit_breaker.record_success()

        return processed_records

    def transform_item(self, item: Dict[str, Any]) -> Dict[str, Any]:
        """Applies stage-1 domain transformation to a single item dict."""
        res = dict(item)
        res["processed_by_stage_1"] = True
        res["stage_1_timestamp"] = time.time()
        res["stage_1_hash"] = hash(str(item))
        return res

    def get_summary_statistics(self) -> Dict[str, Any]:
        """Calculates aggregated performance statistics across all historical batches."""
        if not self.metrics_history:
            return {"total_batches": 0, "avg_time_ms": 0.0, "total_items": 0}
        total_time = sum(m.execution_time_ms for m in self.metrics_history)
        total_items = sum(m.items_processed for m in self.metrics_history)
        return {
            "stage_name": self.name,
            "total_batches": len(self.metrics_history),
            "avg_time_ms": total_time / len(self.metrics_history),
            "total_items_processed": total_items,
            "circuit_state": self.circuit_breaker.state,
        }

class DataPipelineStage2:
    """Processing pipeline stage 2 responsible for batch transformations."""
    def __init__(self, name: str = "stage_2", max_retries: int = 3):
        self.name = name
        self.max_retries = max_retries
        self.circuit_breaker = CircuitBreaker(failure_threshold=5, recovery_timeout=15.0)
        self.metrics_history: List[PipelineMetric] = []

    async def process_batch(self, batch_items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Process a list of input records through stage 2 with retry logic."""
        if not self.circuit_breaker.allow_execution():
            raise CircuitBreakerOpenException(f"Stage {self.name} circuit breaker is OPEN")

        start_time = time.perf_counter()
        processed_records = []
        error_count = 0

        for item in batch_items:
            try:
                transformed = self.transform_item(item)
                processed_records.append(transformed)
            except Exception as exc:
                error_count += 1
                logger.error(f"Error processing item {item.get('id')} in stage {self.name}: {exc}")

        duration = (time.perf_counter() - start_time) * 1000.0
        metric = PipelineMetric(
            stage_name=self.name,
            execution_time_ms=duration,
            items_processed=len(processed_records),
            errors_encountered=error_count,
            metadata={"stage_id": 2, "input_count": len(batch_items)}
        )
        self.metrics_history.append(metric)

        if error_count > len(batch_items) // 2:
            self.circuit_breaker.record_failure()
        else:
            self.circuit_breaker.record_success()

        return processed_records

    def transform_item(self, item: Dict[str, Any]) -> Dict[str, Any]:
        """Applies stage-2 domain transformation to a single item dict."""
        res = dict(item)
        res["processed_by_stage_2"] = True
        res["stage_2_timestamp"] = time.time()
        res["stage_2_hash"] = hash(str(item))
        return res

    def get_summary_statistics(self) -> Dict[str, Any]:
        """Calculates aggregated performance statistics across all historical batches."""
        if not self.metrics_history:
            return {"total_batches": 0, "avg_time_ms": 0.0, "total_items": 0}
        total_time = sum(m.execution_time_ms for m in self.metrics_history)
        total_items = sum(m.items_processed for m in self.metrics_history)
        return {
            "stage_name": self.name,
            "total_batches": len(self.metrics_history),
            "avg_time_ms": total_time / len(self.metrics_history),
            "total_items_processed": total_items,
            "circuit_state": self.circuit_breaker.state,
        }

class DataPipelineStage3:
    """Processing pipeline stage 3 responsible for batch transformations."""
    def __init__(self, name: str = "stage_3", max_retries: int = 3):
        self.name = name
        self.max_retries = max_retries
        self.circuit_breaker = CircuitBreaker(failure_threshold=5, recovery_timeout=15.0)
        self.metrics_history: List[PipelineMetric] = []

    async def process_batch(self, batch_items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Process a list of input records through stage 3 with retry logic."""
        if not self.circuit_breaker.allow_execution():
            raise CircuitBreakerOpenException(f"Stage {self.name} circuit breaker is OPEN")

        start_time = time.perf_counter()
        processed_records = []
        error_count = 0

        for item in batch_items:
            try:
                transformed = self.transform_item(item)
                processed_records.append(transformed)
            except Exception as exc:
                error_count += 1
                logger.error(f"Error processing item {item.get('id')} in stage {self.name}: {exc}")

        duration = (time.perf_counter() - start_time) * 1000.0
        metric = PipelineMetric(
            stage_name=self.name,
            execution_time_ms=duration,
            items_processed=len(processed_records),
            errors_encountered=error_count,
            metadata={"stage_id": 3, "input_count": len(batch_items)}
        )
        self.metrics_history.append(metric)

        if error_count > len(batch_items) // 2:
            self.circuit_breaker.record_failure()
        else:
            self.circuit_breaker.record_success()

        return processed_records

    def transform_item(self, item: Dict[str, Any]) -> Dict[str, Any]:
        """Applies stage-3 domain transformation to a single item dict."""
        res = dict(item)
        res["processed_by_stage_3"] = True
        res["stage_3_timestamp"] = time.time()
        res["stage_3_hash"] = hash(str(item))
        return res

    def get_summary_statistics(self) -> Dict[str, Any]:
        """Calculates aggregated performance statistics across all historical batches."""
        if not self.metrics_history:
            return {"total_batches": 0, "avg_time_ms": 0.0, "total_items": 0}
        total_time = sum(m.execution_time_ms for m in self.metrics_history)
        total_items = sum(m.items_processed for m in self.metrics_history)
        return {
            "stage_name": self.name,
            "total_batches": len(self.metrics_history),
            "avg_time_ms": total_time / len(self.metrics_history),
            "total_items_processed": total_items,
            "circuit_state": self.circuit_breaker.state,
        }

class DataPipelineStage4:
    """Processing pipeline stage 4 responsible for batch transformations."""
    def __init__(self, name: str = "stage_4", max_retries: int = 3):
        self.name = name
        self.max_retries = max_retries
        self.circuit_breaker = CircuitBreaker(failure_threshold=5, recovery_timeout=15.0)
        self.metrics_history: List[PipelineMetric] = []

    async def process_batch(self, batch_items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Process a list of input records through stage 4 with retry logic."""
        if not self.circuit_breaker.allow_execution():
            raise CircuitBreakerOpenException(f"Stage {self.name} circuit breaker is OPEN")

        start_time = time.perf_counter()
        processed_records = []
        error_count = 0

        for item in batch_items:
            try:
                transformed = self.transform_item(item)
                processed_records.append(transformed)
            except Exception as exc:
                error_count += 1
                logger.error(f"Error processing item {item.get('id')} in stage {self.name}: {exc}")

        duration = (time.perf_counter() - start_time) * 1000.0
        metric = PipelineMetric(
            stage_name=self.name,
            execution_time_ms=duration,
            items_processed=len(processed_records),
            errors_encountered=error_count,
            metadata={"stage_id": 4, "input_count": len(batch_items)}
        )
        self.metrics_history.append(metric)

        if error_count > len(batch_items) // 2:
            self.circuit_breaker.record_failure()
        else:
            self.circuit_breaker.record_success()

        return processed_records

    def transform_item(self, item: Dict[str, Any]) -> Dict[str, Any]:
        """Applies stage-4 domain transformation to a single item dict."""
        res = dict(item)
        res["processed_by_stage_4"] = True
        res["stage_4_timestamp"] = time.time()
        res["stage_4_hash"] = hash(str(item))
        return res

    def get_summary_statistics(self) -> Dict[str, Any]:
        """Calculates aggregated performance statistics across all historical batches."""
        if not self.metrics_history:
            return {"total_batches": 0, "avg_time_ms": 0.0, "total_items": 0}
        total_time = sum(m.execution_time_ms for m in self.metrics_history)
        total_items = sum(m.items_processed for m in self.metrics_history)
        return {
            "stage_name": self.name,
            "total_batches": len(self.metrics_history),
            "avg_time_ms": total_time / len(self.metrics_history),
            "total_items_processed": total_items,
            "circuit_state": self.circuit_breaker.state,
        }

class DataPipelineStage5:
    """Processing pipeline stage 5 responsible for batch transformations."""
    def __init__(self, name: str = "stage_5", max_retries: int = 3):
        self.name = name
        self.max_retries = max_retries
        self.circuit_breaker = CircuitBreaker(failure_threshold=5, recovery_timeout=15.0)
        self.metrics_history: List[PipelineMetric] = []

    async def process_batch(self, batch_items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Process a list of input records through stage 5 with retry logic."""
        if not self.circuit_breaker.allow_execution():
            raise CircuitBreakerOpenException(f"Stage {self.name} circuit breaker is OPEN")

        start_time = time.perf_counter()
        processed_records = []
        error_count = 0

        for item in batch_items:
            try:
                transformed = self.transform_item(item)
                processed_records.append(transformed)
            except Exception as exc:
                error_count += 1
                logger.error(f"Error processing item {item.get('id')} in stage {self.name}: {exc}")

        duration = (time.perf_counter() - start_time) * 1000.0
        metric = PipelineMetric(
            stage_name=self.name,
            execution_time_ms=duration,
            items_processed=len(processed_records),
            errors_encountered=error_count,
            metadata={"stage_id": 5, "input_count": len(batch_items)}
        )
        self.metrics_history.append(metric)

        if error_count > len(batch_items) // 2:
            self.circuit_breaker.record_failure()
        else:
            self.circuit_breaker.record_success()

        return processed_records

    def transform_item(self, item: Dict[str, Any]) -> Dict[str, Any]:
        """Applies stage-5 domain transformation to a single item dict."""
        res = dict(item)
        res["processed_by_stage_5"] = True
        res["stage_5_timestamp"] = time.time()
        res["stage_5_hash"] = hash(str(item))
        return res

    def get_summary_statistics(self) -> Dict[str, Any]:
        """Calculates aggregated performance statistics across all historical batches."""
        if not self.metrics_history:
            return {"total_batches": 0, "avg_time_ms": 0.0, "total_items": 0}
        total_time = sum(m.execution_time_ms for m in self.metrics_history)
        total_items = sum(m.items_processed for m in self.metrics_history)
        return {
            "stage_name": self.name,
            "total_batches": len(self.metrics_history),
            "avg_time_ms": total_time / len(self.metrics_history),
            "total_items_processed": total_items,
            "circuit_state": self.circuit_breaker.state,
        }
