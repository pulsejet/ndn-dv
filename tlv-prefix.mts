import {
  StructBuilder,
  StructFieldBool,
  StructFieldBytes,
  StructFieldNNI,
} from "@ndn/tlv";
import { Encoder, Decoder } from "@ndn/tlv";
import {
  Name,
  Component,
  TT as l3TT,
  StructFieldName,
  StructFieldComponentNested,
} from "@ndn/packet";

import { IPrefixOps, IRibEntry, TT } from "./typings.mjs";

const buildOpList = new StructBuilder("opList", TT.list)
  .add(TT.destination, "exitRouter", StructFieldName, {
    required: true,
  })
  .add(TT.reset, "opReset", StructFieldBool, {
    required: false,
  })
  .add(TT.update, "opUpdates", StructFieldComponentNested, {
    required: false,
    repeat: true,
  });

export class OpList extends buildOpList.baseClass<OpList>() {}

buildOpList.subclass = OpList;

const buildOpUpdate = new StructBuilder("opUpdate", TT.list)
  .add(TT.add, "opAdd", StructFieldName, {
    required: false,
  })
  .add(TT.remove, "opRemove", StructFieldName, {
    required: false,
  });

export class OpUpdate extends buildOpUpdate.baseClass<OpUpdate>() {}

buildOpUpdate.subclass = OpUpdate;

export function encodeOpList(ops: IPrefixOps) {
  const { updates, reset, router } = ops;
  const opListObj = new OpList();
  opListObj.exitRouter = new Name(router);
  if (updates && updates.length) {
    opListObj.opUpdates = updates.map((entry) => {
      const opUpdate = new OpUpdate();
      const [prefix, op] = Object.entries(entry)[0];
      if (op === "add") {
        opUpdate.opAdd = new Name(prefix);
      } else {
        opUpdate.opRemove = new Name(prefix);
      }
      return new Component(Encoder.encode(opUpdate));
    });
  }

  if (reset) {
    opListObj.opReset = true;
  }
  return Encoder.encode(opListObj);
}

export function decodeOpList(data: Uint8Array) {
  const dataObj = Decoder.decode(data, OpList);
  const { opUpdates, opReset, exitRouter } = dataObj;
  const ops: IPrefixOps = { router: exitRouter.toString() };
  if (opUpdates && opUpdates.length) {
    ops.updates = opUpdates.map((update) => {
      const decodedUpdate = Decoder.decode(update.tlv, OpUpdate);
      const { opAdd, opRemove } = decodedUpdate;
      if (opAdd) {
        return { [(opAdd as Name).toString()]: "add" };
      } else {
        return { [(opRemove as Name).toString()]: "add" };
      }
    });
  }

  if (opReset) {
    ops.reset = true;
  }
  return ops;
}
