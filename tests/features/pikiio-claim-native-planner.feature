Feature: ACTION-01 claim-native planner stays default-off and evidence-bound

  Scenario: Scheduled destination delivery cannot become completed delivery
    Given an accepted destination-delivery claim with scheduled polarity
    When the claim-native planner evaluates the shipment
    Then the POD family does not act on a scheduled event

  Scenario: Origin pickup cannot satisfy destination delivery
    Given accepted completion evidence for the origin pickup leg only
    When the claim-native planner evaluates the destination leg
    Then the destination delivery and POD gates remain open

  Scenario: Delivery confirmed and POD promised never means POD received
    Given accepted delivery confirmation and a fresh POD promise
    When the claim-native planner evaluates the shipment
    Then it records delivery with POD still pending

  Scenario: Fresh POD promise creates an evidence-cited wait
    Given a fresh accepted commitment to send POD after unloading
    When the planner evaluates within the courtesy window
    Then it waits and cites the commitment claim

  Scenario: Expired POD promise permits a courteous proposal
    Given an accepted POD promise whose courtesy window expired
    When the planner evaluates after the promised window
    Then it proposes a POD follow-up without executing it

  Scenario: Terminal lifecycle cannot hide an open POD obligation
    Given a delivered shipment whose POD gate remains open
    When the claim-native planner classifies working cohorts
    Then the shipment remains actionable after terminal delivery

  Scenario: Accepted leg owner resolves the execution counterparty
    Given an accepted destination-leg owner claim with thread provenance
    When the planner proposes an execution-side ask
    Then recipient and thread come from that owner claim

  Scenario: Missing leg owner fails closed
    Given delivery evidence without an accepted destination-leg owner
    When the planner considers an execution-side ask
    Then it waits with a named missing-owner-claim reason

  Scenario: Recipient rosters are never a counterparty fallback
    Given an unrelated thread recipient roster and no accepted leg owner
    When the planner considers an execution-side ask
    Then it does not select a recipient from the roster

  Scenario: Client contacts cannot receive execution-side POD asks
    Given an accepted client relationship and a distinct delivery-leg owner
    When the planner proposes a POD follow-up
    Then only the accepted delivery-leg owner is the candidate recipient

  Scenario: Every decision cites accepted claim versions
    Given a claim-native packet with a sealed accepted-claim set
    When the planner emits a wait act blocked or completed decision
    Then every cited claim belongs to the sealed set

  Scenario: Identical inputs produce identical decision identifiers
    Given the same packet clock flag and accepted claims
    When the claim-native planner evaluates the input twice
    Then both complete outputs and identifiers are byte-equivalent

  Scenario: Default-off mode cannot publish an action
    Given the claim-native planner production flag is disabled
    When an otherwise eligible POD proposal is evaluated
    Then action draft and send queues remain unchanged

  Scenario: Raw email summaries cannot strengthen accepted truth
    Given raw summary text that contradicts the sealed accepted claims
    When the claim-native planner evaluates the shipment
    Then the decision follows accepted claims and ignores raw summary text

  Scenario: Unknown claim polarity fails closed
    Given an accepted-looking delivery claim with unknown polarity
    When the claim-native planner evaluates the shipment
    Then it blocks with a named unsupported-polarity reason
