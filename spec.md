# ndn-dv

## 1. Basic Protocol Design

(will replace with diagram)
advertisements -> RIB updates (sync group for each node)
global sync group for global prefix table, each router uses it to compute FIB

## 2. Format and Naming

### Advertisement

## 3. TLV Specification

```
Advertisement = ADVERTISEMENT-TYPE TLV-LENGTH
  *RIBEntry

RIBEntry = RIB-ENTRY-TYPE TLV-LENGTH
  Destination
  NextHop
  Cost
  Other

Destination = DESTINATION-TYPE TLV-LENGTH Name
NextHop = NEXT-HOP-TYPE TLV-LENGTH Name
Cost = COST-TYPE TLV-LENGTH NonNegativeInteger
Other = OTHER-TYPE TLV-LENGTH NonNegativeInteger

DESTIONATION-TYPE = 201
NEXT-HOP-TYPE = 202
ADVERTISEMENT-TYPE = 203
RIB-ENTRY-TYPE = 204
COST-TYPE = 205
OTHER-TYPE = 206
```

global mapping table later

## 4. Protocol Operation

### A. Advertisements

- Computed whenever RIB changes
- Fields:
  - `Destination`: Preconfigured name for every other router in network
  - `Next Hop`: Best known next hop router for reaching a destination
  - `Cost`: Cost of using `Next Hop` router
  - `Other`: Cost of using second-best next-hop router
- Router informs immediate neighbors of new advertisements via SVS Sync update interests, increasing sequence number upon change, neighbors then must fetch interests
- Each router also periodically fetches advertisements from neighbors every **2** seconds
- Remove neighbor's advertisements from RIB update consideration after **5** failures

### B. RIB Computation

- Triggered upon detecting change in neighbor's advertisement (criteria above)
- For each `Destination`:
  - If `Cost` < **16**:
    - Cost to destination = 1 + neighbor's advertised cost
  - If `Cost` >= **16** or not advertised:
    - Cost to destination = infinity
  - If `Next Hop` is the current processing router:
    - If `Other` < **16**:
      - Cost to destination = other
    - Else:
      - Cost to destination = infinity

### C. FIB Computation

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
