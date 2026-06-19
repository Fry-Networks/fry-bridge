#!/usr/bin/env python3
"""Deploy Fry Bridge Algorand contract to localnet."""
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


def main():
    algod_client = algod.AlgodClient(ALGOD_TOKEN, ALGOD_URL)
    deployer_addr, deployer_pk = get_funded_account()
    signer = AccountTransactionSigner(deployer_pk)
    print(f"Deployer: {deployer_addr}")
    sp = algod_client.suggested_params()

    # 1. Compile TEAL
    approval_prog = compile_program(algod_client, APPROVAL_TEAL)
    clear_prog = compile_program(algod_client, CLEAR_TEAL)
    print(f"Approval: {len(approval_prog)} bytes")
    print(f"Clear:    {len(clear_prog)} bytes")

    # 2. Create fSOL ASA first (needed for initialize)
    fsol_txn = transaction.AssetConfigTxn(
        sender=deployer_addr,
        sp=sp,
        total=1_000_000_000_000_000,
        decimals=6,
        default_frozen=False,
        unit_name="fSOL",
        asset_name="Fry SOL",
        url="",
        metadata_hash=None,
        manager=deployer_addr,
        reserve=deployer_addr,
        freeze=deployer_addr,
        clawback=deployer_addr,
    )
    signed_fsol = fsol_txn.sign(deployer_pk)
    fsol_txid = algod_client.send_transaction(signed_fsol)
    fsol_result = wait_for_confirmation(algod_client, fsol_txid)
    fsol_asa_id = fsol_result["asset-index"]
    print(f"fSOL ASA ID: {fsol_asa_id}")

    # 3. Create application (bare NoOp)
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

    # 4. Fund app with ALGO
    fund_txn = transaction.PaymentTxn(
        sender=deployer_addr,
        sp=sp,
        receiver=app_addr,
        amt=500_000_000,  # 500 ALGO
    )
    signed_fund = fund_txn.sign(deployer_pk)
    fund_txid = algod_client.send_transaction(signed_fund)
    wait_for_confirmation(algod_client, fund_txid)
    print("Funded app with 500 ALGO")

    # 5. Call initialize via ABI
    contract = Contract.from_json(open("algorand/contract.json").read())
    init_method = contract.get_method_by_name("initialize")
    atc = AtomicTransactionComposer()
    atc.add_method_call(
        app_id,
        init_method,
        deployer_addr,
        sp,
        signer,
        method_args=[deployer_addr, fsol_asa_id],
        accounts=[deployer_addr],
    )
    result = atc.execute(algod_client, 3)
    print(f"Initialized: {result.tx_ids[0]}")

    # 6. Call set_limits via ABI
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

    # 7. Call optin_asa for fSOL
    optin_method = contract.get_method_by_name("optin_asa")
    atc3 = AtomicTransactionComposer()
    atc3.add_method_call(
        app_id,
        optin_method,
        deployer_addr,
        sp,
        signer,
        method_args=[fsol_asa_id],
        accounts=[],
        foreign_assets=[fsol_asa_id],
    )
    result3 = atc3.execute(algod_client, 3)
    print(f"App opted into fSOL: {result3.tx_ids[0]}")

    # 8. Transfer fSOL to app
    xfer_fsol = transaction.AssetTransferTxn(
        sender=deployer_addr,
        sp=sp,
        receiver=app_addr,
        amt=1_000_000_000_000,  # 1M fSOL
        index=fsol_asa_id,
    )
    signed_xfer = xfer_fsol.sign(deployer_pk)
    xfer_txid = algod_client.send_transaction(signed_xfer)
    wait_for_confirmation(algod_client, xfer_txid)
    print(f"Transferred 1M fSOL to app")

    # 9. Create test FRY 2.0 ASA
    fry_txn = transaction.AssetConfigTxn(
        sender=deployer_addr,
        sp=sp,
        total=1_000_000_000_000_000,
        decimals=6,
        default_frozen=False,
        unit_name="FRY2",
        asset_name="Fry 2.0",
        url="",
        metadata_hash=None,
        manager=deployer_addr,
        reserve=deployer_addr,
        freeze=deployer_addr,
        clawback=deployer_addr,
    )
    signed_fry = fry_txn.sign(deployer_pk)
    fry_txid = algod_client.send_transaction(signed_fry)
    fry_result = wait_for_confirmation(algod_client, fry_txid)
    fry_asa_id = fry_result["asset-index"]
    print(f"FRY 2.0 ASA ID: {fry_asa_id}")

    # 10. Call optin_asa for FRY 2.0
    atc4 = AtomicTransactionComposer()
    atc4.add_method_call(
        app_id,
        optin_method,
        deployer_addr,
        sp,
        signer,
        method_args=[fry_asa_id],
        accounts=[],
        foreign_assets=[fry_asa_id],
    )
    result4 = atc4.execute(algod_client, 3)
    print(f"App opted into FRY 2.0: {result4.tx_ids[0]}")

    # 11. Transfer FRY 2.0 to app
    xfer_fry = transaction.AssetTransferTxn(
        sender=deployer_addr,
        sp=sp,
        receiver=app_addr,
        amt=1_000_000_000_000,  # 1M FRY 2.0
        index=fry_asa_id,
    )
    signed_xfer_fry = xfer_fry.sign(deployer_pk)
    xfer_fry_txid = algod_client.send_transaction(signed_xfer_fry)
    wait_for_confirmation(algod_client, xfer_fry_txid)
    print(f"Transferred 1M FRY 2.0 to app")

    # 12. Output config
    print("\n=== ALGORAND DEPLOY CONFIG ===")
    print(f"AppID={app_id}")
    print(f"fSOL_ASA_ID={fsol_asa_id}")
    print(f"FRY20_ASA_ID={fry_asa_id}")
    print(f"Relayer={deployer_addr}")
    print("================================")


if __name__ == "__main__":
    main()
