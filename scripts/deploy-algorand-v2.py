#!/usr/bin/env python3
"""Deploy a fresh Fry Bridge Algorand app reusing existing localnet ASAs."""
import json
import base64
import os
from algosdk.v2client import algod
from algosdk import kmd, transaction
from algosdk.atomic_transaction_composer import (
    AtomicTransactionComposer,
    TransactionWithSigner,
    AccountTransactionSigner,
)
from algosdk.abi import Contract

ALGOD_URL = "http://localhost:4001"
ALGOD_TOKEN = "a" * 64
KMD_URL = "http://localhost:4002"
KMD_TOKEN = "a" * 64
APPROVAL_TEAL = "algorand/approval.teal"
CLEAR_TEAL = "algorand/clear.teal"

FSOL_ASA = int(os.environ.get("FSOL_ASA", "1105"))
FRY2_ASA = int(os.environ.get("FRY2_ASA", "1113"))


def get_funded_account():
    kmd_client = kmd.KMDClient(KMD_TOKEN, KMD_URL)
    wallets = kmd_client.list_wallets()
    wallet_id = wallets[0]["id"]
    wallet_handle = kmd_client.init_wallet_handle(wallet_id, "")
    accounts = kmd_client.list_keys(wallet_handle)
    addr = accounts[0]
    pk = kmd_client.export_key(wallet_handle, "", addr)
    kmd_client.release_wallet_handle(wallet_handle)
    return addr, pk


def compile_program(client, fname):
    with open(fname, "r") as f:
        source = f.read()
    response = client.compile(source)
    return base64.b64decode(response["result"])


def wait_for_confirmation(client, txid):
    last_round = client.status()["last-round"]
    while True:
        txinfo = client.pending_transaction_info(txid)
        if txinfo.get("confirmed-round", 0) > 0:
            return txinfo
        elif txinfo.get("pool-error"):
            raise Exception(f"TX rejected: {txinfo['pool-error']}")
        client.status_after_block(last_round)
        last_round += 1


def send_asset(client, sender, sk, receiver, amt, index):
    sp = client.suggested_params()
    txn = transaction.AssetTransferTxn(
        sender=sender,
        sp=sp,
        receiver=receiver,
        amt=amt,
        index=index,
    )
    signed = txn.sign(sk)
    txid = client.send_transaction(signed)
    wait_for_confirmation(client, txid)
    return txid


def main():
    algod_client = algod.AlgodClient(ALGOD_TOKEN, ALGOD_URL)
    deployer_addr, deployer_pk = get_funded_account()
    signer = AccountTransactionSigner(deployer_pk)
    print(f"Deployer: {deployer_addr}")
    sp = algod_client.suggested_params()

    approval_prog = compile_program(algod_client, APPROVAL_TEAL)
    clear_prog = compile_program(algod_client, CLEAR_TEAL)
    print(f"Approval: {len(approval_prog)} bytes")
    print(f"Clear:    {len(clear_prog)} bytes")

    create_txn = transaction.ApplicationCreateTxn(
        sender=deployer_addr,
        sp=sp,
        on_complete=transaction.OnComplete.NoOpOC,
        approval_program=approval_prog,
        clear_program=clear_prog,
        global_schema=transaction.StateSchema(num_uints=12, num_byte_slices=2),
        local_schema=transaction.StateSchema(num_uints=0, num_byte_slices=0),
        extra_pages=3,
    )
    signed_create = create_txn.sign(deployer_pk)
    create_txid = algod_client.send_transaction(signed_create)
    create_result = wait_for_confirmation(algod_client, create_txid)
    app_id = create_result["application-index"]
    app_addr = transaction.logic.get_application_address(app_id)
    print(f"App ID: {app_id}")
    print(f"App Address: {app_addr}")

    fund_txn = transaction.PaymentTxn(
        sender=deployer_addr,
        sp=sp,
        receiver=app_addr,
        amt=500_000_000,
    )
    signed_fund = fund_txn.sign(deployer_pk)
    fund_txid = algod_client.send_transaction(signed_fund)
    wait_for_confirmation(algod_client, fund_txid)
    print("Funded app with 500 ALGO")

    contract = Contract.from_json(open("algorand/contract.json").read())

    init_method = contract.get_method_by_name("initialize")
    atc = AtomicTransactionComposer()
    atc.add_method_call(
        app_id,
        init_method,
        deployer_addr,
        sp,
        signer,
        method_args=[deployer_addr, FSOL_ASA],
        accounts=[deployer_addr],
    )
    result = atc.execute(algod_client, 3)
    print(f"Initialized: {result.tx_ids[0]}")

    limits_method = contract.get_method_by_name("set_limits")
    atc2 = AtomicTransactionComposer()
    atc2.add_method_call(
        app_id,
        limits_method,
        deployer_addr,
        sp,
        signer,
        method_args=[1_000_000, 10_000_000, 100_000_000, 10_000_000, 300],
        accounts=[],
    )
    result2 = atc2.execute(algod_client, 3)
    print(f"Set limits: {result2.tx_ids[0]}")

    optin_method = contract.get_method_by_name("optin_asa")
    for asa_id in (FSOL_ASA, FRY2_ASA):
        atc_opt = AtomicTransactionComposer()
        atc_opt.add_method_call(
            app_id,
            optin_method,
            deployer_addr,
            sp,
            signer,
            method_args=[asa_id],
            accounts=[],
            foreign_assets=[asa_id],
        )
        r = atc_opt.execute(algod_client, 3)
        print(f"App opted into ASA {asa_id}: {r.tx_ids[0]}")

    send_asset(algod_client, deployer_addr, deployer_pk, app_addr, 1_000_000_000_000, FSOL_ASA)
    print(f"Transferred 1M fSOL to app")
    send_asset(algod_client, deployer_addr, deployer_pk, app_addr, 1_000_000_000_000, FRY2_ASA)
    print(f"Transferred 1M FRY2 to app")

    print("\n=== ALGORAND DEPLOY CONFIG ===")
    print(f"AppID={app_id}")
    print(f"fSOL_ASA_ID={FSOL_ASA}")
    print(f"FRY20_ASA_ID={FRY2_ASA}")
    print(f"Relayer={deployer_addr}")
    print("================================")


if __name__ == "__main__":
    main()
