# ndn-dv

This page describes the protocol specification of NDN Distance Vector Routing (ndn-dv).

## 1. Basic Protocol Design

1. All routers must have a unique *name* in the network for identification,
   and routers should be able to mutually authenticate each other.

1. Every router maintains a Routing Information Base (RIB) and
   computes a single *Advertisement* every time the RIB changes.
   The Advertisement is synchronized with all *neighbors* using a
   router-specific State Vector Sync group (*Advertisement Sync* group).

1. All routers join a global *Prefix Sync* SVS group to synchronize the
   global prefix table, which contains the mapping of prefixes to
   routers that can reach them.

## 2. Format and Naming

**Advertisement Sync group prefix**: `/<node-prefix>/32=DV/32=ADS/`

**Advertisement Data Format**: `/<node-prefix>/32=DV/32=ADV/58=<seq-num>`

**Prefix Sync group prefix**: `/<network-prefix>/32=DV/32=PFXS/`

**Prefix Data Format**: `/<node-prefix>/32=DV/32=PFX/58=<seq-num>`

`<node-prefix>` is the router's unique name in the network.

`<network-prefix>` is the globally unique network prefix.

## 3. TLV Specification

```abnf
Advertisement = ADVERTISEMENT-TYPE TLV-LENGTH
                *Link
                *AdvEntry

Link = LINK-TYPE TLV-LENGTH
       Interface
       Neighbor

Interface = INTERFACE-TYPE TLV-LENGTH NonNegativeInteger
Neighbor = NEIGHBOR-TYPE TLV-LENGTH Name

AdvEntry = ADV-ENTRY-TYPE TLV-LENGTH
           Destination
           Interface
           Cost
           OtherCost

Destination = DESTINATION-TYPE TLV-LENGTH Name
Cost = COST-TYPE TLV-LENGTH NonNegativeInteger
OtherCost = OTHER-COST-TYPE TLV-LENGTH NonNegativeInteger

ADVERTISEMENT-TYPE = 201
LINK-TYPE = 202
INTERFACE-TYPE = 203
NEIGHBOR-TYPE = 204
ADV-ENTRY-TYPE = 205
DESTINATION-TYPE = 206
COST-TYPE = 207
OTHER-COST-TYPE = 208
```

TODO: global mapping table

## 4. Protocol Operation

### A. RIB State

Each router maintains a list of RIB entries as the RIB state. Each RIB entry
contains the following fields:

1. `Destination`: name of the destination router.
1. `Cost (Interface)`: cost to reach destination through this interface (one for each interface).

### B. Advertisement Computation

A new advertisement is computed by the router whenever the RIB changes.

1. `Links` in the advertisement are populated with the router's interfaces.
1. `AdvEntries` are added to the advertisement based on the RIB state.

One `AdvEntry` is generated for each RIB entry and contains the following fields:

1. `Destination`: name of the destination router.
1. `Interface`: Interface identifier for reaching the destination with lowest cost.
1. `Cost`: Cost associated with the next-hop interface.
1. `OtherCost`: Cost associated with the *second-best* next-hop interface.

- When the advertisement changes, the router increments the sequence number for the *Advertisement Sync* group.
- (TODO) The sequence number is incremented periodically every 10 seconds.
- (TODO) Neighbor is considered dead if no update is received for 3 periods.

### C. Update Processing

On receiving a new advertisement from a neighbor, the router processes the advertisement as follows:

```python
for n in neighbors:
  if n.advertisement is None:
    continue

  for entry in n.advertisement:
    cost = entry.cost + 1

    if entry.nexthop is self:
      if entry.other < INFINITY:
        cost = entry.other + 1
      else:
        cost = INFINITY

    if cost >= INFINITY:
      continue

    rib[entry.destination][n.interface] = cost
```

`INFINITY` is the maximum cost value, set to `16` by default.

### D. FIB Computation

#### Global Prefix Table

- Fields:
  - `Name Prefix`: target prefix
  - `Exit Router`: routers associated with prefix (can you have multiple)
- Each router maintains a copy
- Table synchronized using SVS Sync group consisting of all routers

#### FIB

- Fields:
  - `Name Prefix`: target prefix
  - `Next Hops`: list of interfaces linking to routers that can reach a target prefix, as well as associated cost for that prefix
- Contains entry for all prefixes in prefix table with matching exit router entry in RIB
- (tiebreaker for same cost)
