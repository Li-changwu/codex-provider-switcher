# Recovery Marker Retry Design

## Status

Approved for implementation under Issue #22.

## Problem

`switchProfile` must leave a durable `recoveryRequired` marker when a
transaction cannot be compensated. `TransactionHandle.rollback()` normally
does this itself, but its journal append can fail. The outer switch boundary
currently intends to retry the marker and contains a duplicated negated
condition, so the retry is unreachable.

## Design

Keep the transaction state machine and journal schema unchanged. In
`rollbackAfterFailure`, collect the original rollback error, then call
`markRecoveryRequired()` once when and only when `rollback()` failed. The
retry is best-effort: a successful retry establishes the durable recovery
state, while a second failure is retained only as an internal bounded error
and the function still returns `recoveryRequired`.

The successful rollback path returns `rolledBack` without calling the marker.
Committed transactions remain protected by the existing committed-state
logic, and no mutation rollback callback or credential handling changes.

## Error and Security Boundaries

The original rollback failure remains the primary diagnostic. Marker retry
failures are not exposed with raw filesystem or journal details. The method
does not retry arbitrary transaction operations and does not alter backup
bytes. Recovery remains fail-closed if both the transaction's internal marker
write and the outer retry fail.

## Verification

Unit tests will use the supported auth pre-apply evidence path and inject an
auth restoration failure, so `rollback()` reaches its durable recovery marker
boundary. The first case will fail the transaction's marker publication and
verify the outer retry succeeds on the second attempt. A second case will
fail both publications and verify a bounded `recoveryRequired` result without
leaking injected error text. An existing successful rollback case will verify
no marker retry occurs. The complete type check, unit suite, integration
suite, and whitespace check remain required before the PR.
