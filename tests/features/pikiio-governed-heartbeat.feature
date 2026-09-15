Feature: Governed autonomous Pikiio heartbeat
  The builder may make progress without an operator present only when its
  exact goal, phase, writer capability, quality proof, and external-action
  boundary are machine-verifiable.

  Scenario: Missing controller goal is refused
    Given the canonical Pikiio phase ledger
    When no controller goal objective or task ID is supplied
    Then the goal guard returns CODEX_GOAL_REQUIRED

  Scenario: A mismatched controller goal is refused
    Given the canonical Pikiio phase ledger
    When the controller goal objective differs from the ledger
    Then the goal guard returns CODEX_GOAL_MISMATCH

  Scenario: Unsafe policy mutation is refused
    Given the canonical immutable safety policy
    When oneWriter is false or Gmail send is removed
    Then phase ledger validation fails

  Scenario: Two active phases are refused
    Given the canonical Pikiio phase ledger
    When a second phase is marked active
    Then phase ledger validation fails

  Scenario: A rename from a forbidden path is refused
    Given the active phase allows a governance destination
    When an operational send path is renamed into that destination
    Then the dirty guard checks both rename paths and refuses

  Scenario: A committed forbidden path is refused
    Given the active phase has a committed scope base
    When committed history changes an operational send path
    Then the dirty guard refuses the committed delta

  Scenario: A changed pinned evidence tree is refused
    Given a digest-pinned pre-existing evidence tree
    When one byte of its content changes
    Then the dirty guard refuses write authority

  Scenario: A live writer capability cannot be guessed
    Given a writer lease protected by a random capability
    When another client presents only its public run ID
    Then renew and release are refused

  Scenario: A live expired writer lease cannot be stolen
    Given a same-host writer lease whose holder PID is alive
    When another run tries to acquire it after its expiry timestamp
    Then the second run remains read-only

  Scenario: A dead expired local lease can be reclaimed
    Given a same-host writer lease whose holder PID is dead
    When another run acquires it after expiry under serialization
    Then the fence increments and the stale receipt is preserved

  Scenario: Morning priority begins exactly at 05:45 New York
    Given no valid terminal receipt for the New York service date
    When a builder requests a lease at 05:45:00
    Then lease admission returns MORNING_PRIORITY_WINDOW_ACTIVE

  Scenario: A builder lease cannot cross the morning boundary
    Given a builder requests a lease before the New York morning boundary
    When its requested expiry crosses 05:45
    Then its expiry is capped at the boundary

  Scenario: A tampered morning receipt does not end priority
    Given a morning terminal receipt with a mismatched hash
    When builder admission checks the service date
    Then morning priority remains active

  Scenario: A future morning receipt does not end priority
    Given a correctly hashed morning receipt dated after the current time
    When builder admission checks the service date
    Then morning priority remains active

  Scenario: Caller lease metadata cannot forge persisted scope
    Given a capability-bound persisted writer lease
    When the caller changes only its phase metadata
    Then receipt append returns WRITER_LEASE_LOST

  Scenario: An expired lease cannot authorize a run receipt
    Given a capability-bound writer lease past its expiry
    When a run receipt is appended
    Then receipt append returns WRITER_LEASE_EXPIRED

  Scenario: Signed quality evidence below threshold is refused
    Given a correctly hashed quality receipt
    When its measured line coverage is below the active profile
    Then quality receipt validation fails

  Scenario: Asynchronous work cannot use the synchronous operation lock
    Given the serialized synchronous operation lock
    When its callback returns a Promise
    Then the lock returns ASYNC_OPERATION_LOCK_CALLBACK_REFUSED

  Scenario: Production mutation requires the sole wrapper
    Given the governance phase has production authority disabled
    When a direct production action is requested from the goal guard
    Then the request returns PRODUCTION_WRAPPER_REQUIRED

  Scenario: Run receipt callers cannot forge authority fields
    Given a capability-bound live writer lease and quality receipt
    When caller payload includes a false goal hash and starting commit
    Then the appended receipt uses reconstructed trusted values

  Scenario: A tampered receipt chain blocks append
    Given a valid two-entry hash-chained receipt log
    When the first receipt content is changed
    Then full-chain verification and the next append fail

  Scenario: Quality thresholds cannot be weakened with behavior
    Given the critical Pikiio quality profile
    When any threshold is reduced or a required evidence layer is removed
    Then phase ledger validation fails

  Scenario: Gherkin step text is executable contract
    Given an exact scenario and exact registered steps
    When any Given When or Then text is changed
    Then the Gherkin verifier reports an undefined contract

  Scenario: External freight actions remain forbidden
    Given any autonomous Pikiio phase
    When its external effect policy is validated
    Then every canonical Gmail and freight mutation remains denied

  Scenario: Missing or stale activation receipt refuses an active heartbeat
    Given a post-governance phase with exact quality evidence
    When its activation receipt is absent or expired
    Then activation validation fails

  Scenario: Exact activation receipt permits a post-governance heartbeat
    Given a post-governance phase with exact quality evidence
    When its phase head ledger and quality receipt all match
    Then activation validation passes

  Scenario: A planned phase receipt cannot activate the heartbeat
    Given a ledger whose active phase differs from a planned phase receipt
    When the otherwise valid activation receipt names the planned phase
    Then activation validation fails on active phase identity

  Scenario: A phase transition requires its complete quality receipt
    Given an otherwise canonical phase transition with an invented receipt hash
    When committed transition history is validated
    Then transition history refuses the fabricated completion evidence

  Scenario: Perfect percentages cannot hide a collapsed test population
    Given a correctly hashed quality receipt with perfect percentages
    When its unit mutant or Gherkin population falls below the pinned floor
    Then quality receipt validation fails on population evidence

  Scenario: Heartbeat state follows governed phase readiness
    Given the canonical phase ledger and heartbeat state
    When the heartbeat automation contract is inspected
    Then a paused heartbeat is safe and an active heartbeat requires completed governance

  Scenario: Heartbeat prompt drift cannot acquire authority
    Given the exact checked-in heartbeat prompt
    When the configured heartbeat prompt differs by one byte
    Then automation contract validation refuses the drift

  Scenario: Candidate-owned authority cannot certify itself
    Given the frozen external phase authority registry
    When every phase changes its authority baseline to candidate
    Then the phase proof registry refuses self-certification

  Scenario: Core phase proof cannot substitute for external certification
    Given a valid core phase proof and synthetic external collector authority
    When the signed envelope and exact expected context are validated
    Then external certification passes and a core-only substitute is refused

  Scenario: A substituted GitHub signing registry is refused
    Given the independently pinned GitHub OIDC JWKS registry
    When a different internally consistent registry is substituted
    Then the external collector refuses the substituted signing authority

  Scenario: Durable raw evidence survives runtime artifact deletion
    Given a strict quality receipt with embedded content-addressed judge bytes
    When no runtime artifact file exists
    Then quality validation replays the exact embedded evidence and rejects tampering

  Scenario: Host durability requires exact live keep-awake evidence
    Given a fresh ready host durability receipt
    When service state plist bytes sleep policy or assertions differ
    Then every altered host receipt is refused

  Scenario: Every post-governance lease samples fresh host durability
    Given a valid post-governance activation and clean checkpoint
    When the live host durability sample is invalid
    Then lease admission refuses before creating bootstrap state

  Scenario: Interrupted phase transition is recovered or refused atomically
    Given a durable transition intent with an uncommitted artifact pair
    When recovery sees exact divergent or tampered transition state
    Then exact orphans roll back and divergent or tampered state fails closed

  Scenario: Content-addressed proof writes never overwrite an existing receipt
    Given an existing content-addressed proof receipt
    When a competing writer targets the same immutable path
    Then the exclusive writer refuses and preserves the original bytes
