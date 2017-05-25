from decimal import Decimal
import os
import sqlite3
from bitcoinrpc.authproxy import AuthServiceProxy
import subprocess
from lbryum.lbrycrd import int_to_hex, rev_hex
from lbryum.transaction import decode_claim_script, script_GetOp, get_address_from_output_script
from lbryschema.decode import smart_decode

hex_to_int = lambda x: int(rev_hex(x), base=16)

URL = "lbry.storni.info"
USER = "niko"

lbrycrdd_path = os.path.join(os.path.expanduser("~"), "Library/Application Support/lbrycrd/lbrycrd.conf")


def get_videos_db():
    print "Fetching video db.sqlite from %s" % URL
    remote_path = '%s@%s:/home/%s/lbry-yt-transfer/db.sqlite' % (USER, URL, USER)
    return subprocess.Popen(['scp', remote_path, "db.sqlite"]).wait()


def get_lbrycrdd_connection_string(wallet_conf):
    settings = {"username": "rpcuser",
                "password": "rpcpassword",
                "rpc_port": 9245}
    if wallet_conf and os.path.exists(wallet_conf):
        with open(wallet_conf, "r") as conf:
            conf_lines = conf.readlines()
        for l in conf_lines:
            if l.startswith("rpcuser="):
                settings["username"] = l[8:].rstrip('\n')
            if l.startswith("rpcpassword="):
                settings["password"] = l[12:].rstrip('\n')
            if l.startswith("rpcport="):
                settings["rpc_port"] = int(l[8:].rstrip('\n'))
    rpc_user = settings["username"]
    rpc_pass = settings["password"]
    rpc_port = settings["rpc_port"]
    rpc_url = "127.0.0.1"
    return "http://%s:%s@%s:%i" % (rpc_user, rpc_pass, rpc_url, rpc_port)


class LBRYcrd(object):
    def __init__(self, lbrycrdd_path):
        self.lbrycrdd_conn_str = get_lbrycrdd_connection_string(lbrycrdd_path)

    def __call__(self, method, *args, **kwargs):
        return self.rpc(method)(*args, **kwargs)

    def rpc(self, method):
        return AuthServiceProxy(self.lbrycrdd_conn_str, service_name=method)


def get_vout(tx, nout):
    for v in tx['vout']:
        if v['n'] == nout:
            return v


def get_claim_vout(txid, tx, name):
    for o in tx['vout']:
        if 'scriptPubKey' in o:
            script_bytes = o['scriptPubKey']['hex'].decode('hex')
            script = [x for x in script_GetOp(script_bytes)]
            decoded = decode_claim_script(script)
            if decoded is not False:
                _name = o['scriptPubKey']['asm'].split(" ")[1].decode('hex')
                if name == _name:
                    return txid


def get_claim_asm(tx, name):
    for o in tx['vout']:
        if 'scriptPubKey' in o:
            script_bytes = o['scriptPubKey']['hex'].decode('hex')
            script = [x for x in script_GetOp(script_bytes)]
            decoded = decode_claim_script(script)
            if decoded is not False:
                _name = o['scriptPubKey']['asm'].split(" ")[1].decode('hex')
                if name == _name:
                    return o['scriptPubKey']['asm']


def get_claim_vins(tx, name, lbrycrdd, updates=None):
    updates = updates or []

    for i in tx['vin']:
        if 'scriptSig' in i:
            if i['txid'] not in updates:
                raw_txin = lbrycrdd("getrawtransaction", i['txid'], 1)
                claim_vout = get_claim_vout(i['txid'], raw_txin, name)
                if claim_vout:
                    updates.append(i['txid'])
                    return get_claim_vins(raw_txin, name, lbrycrdd, updates)
    return updates


def get_block_index(transactions, target_txid):
    for i, txid in enumerate(transactions):
        if txid == target_txid:
            return "%i/%i" % (i + 1, len(transactions))


def get_claim(txid, nout, lbrycrdd):
    raw_tx = lbrycrdd("getrawtransaction", txid, 1)
    blockhash = raw_tx['blockhash']
    block = lbrycrdd("getblock", blockhash)
    height = block['height']
    index = get_block_index(block['tx'], txid)
    asm = get_vout(raw_tx, nout)['scriptPubKey']['asm']
    return {"%s:%i" % (txid, nout): {'block': blockhash, 'height': height, 'index': index,
                                             'asm': asm}}


def get_value_and_address_by_claimid(claim_id, name):
    lbrycrdd = LBRYcrd(os.path.join(os.path.expanduser("~"), "Library/Application Support/lbrycrd/lbrycrd.conf"))
    claims = lbrycrdd("getclaimsforname", name)
    for claim in claims['claims']:
        if claim['claimId'] == claim_id:
            vout = get_vout(lbrycrdd("getrawtransaction", claim['txid'], 1), claim['n'])
            script_bytes = vout['scriptPubKey']['hex'].decode('hex')
            address = get_address_from_output_script(script_bytes)[1][1]
            bytes = "".join(chr(ord(i)) for i in claim['value'])
            return smart_decode(bytes).serialized.encode('hex'), address


def default_decimal(x):
    if isinstance(x, Decimal):
        return float(x)
    return x


def get_claim_chain(txid, name, lbrycrdd):
    raw_tx = lbrycrdd("getrawtransaction", txid, 1)
    claim_chain = get_claim_vins(raw_tx, name, lbrycrdd)
    if len(claim_chain) >= 2:
        updates, root = claim_chain[:-1], claim_chain[-1]
    elif claim_chain:
        updates, root = [], claim_chain
    else:
        updates, root = [], None
    return updates, root


def get_asm(txid, name):
    lbrycrdd = LBRYcrd(lbrycrdd_path)
    raw = lbrycrdd("getrawtransaction", txid, 1)
    return get_claim_asm(raw, name)


def check_name(name):
    lbrycrdd = LBRYcrd(lbrycrdd_path)
    winning = lbrycrdd("getvalueforname", str(name))
    try:
        claim_value = "".join(chr(ord(i)) for i in winning['value'])
        decoded = smart_decode(claim_value)
        winning['value'] = decoded
    except:
        pass
    if winning:
        updates, root = get_claim_chain(winning['txid'], name, lbrycrdd)
        winning['claim updates'] = updates
        winning['claim root'] = root or winning['txid']
        return winning


if __name__ == "__main__":
    lbrycrdd = LBRYcrd(lbrycrdd_path)
    if os.path.isfile("db.sqlite"):
        os.remove("db.sqlite")
    get_videos_db()
    db = sqlite3.connect("db.sqlite")
    cur = db.cursor()
    videos = cur.execute("SELECT videoid, claimname, claim_id, lbrychannel FROM syncd_videos").fetchall()
    db.close()

    signed_claims = {}
    channels = {}
    channel_claims = {}
    print "Checking %i videos" % len(videos)

    for videoid, name, claim_id, channel_name in videos:
        claim = check_name(name)
        if not claim:
            print "There is not a winning claim for %s" % name
        elif claim['claimId'] != claim_id:
            print "Your claim for %s is not winning" % name
        else:
            claim_val = claim['value']
            serialized_claim, claim_address = get_value_and_address_by_claimid(claim['claimId'], name)
            deserialized_claim = smart_decode(serialized_claim)
            signed_claims[claim_id] = (name, claim_address, deserialized_claim)
            if deserialized_claim.certificate_id not in channels:
                channels[deserialized_claim.certificate_id] = channel_name

    for channel_id, channel_name  in channels.iteritems():
        serialized_cert, cert_address = get_value_and_address_by_claimid(channel_id, channel_name)
        deserialized_cert = smart_decode(serialized_cert)
        channel_claims[channel_id] = deserialized_cert.protobuf

    for claim_id, (name, claim_address, claim) in signed_claims.iteritems():
        try:
            cert = channel_claims[claim.certificate_id]
            is_valid = claim.validate_signature(claim_address, cert)
        except:
            is_valid = False
        msg = "Validated" if is_valid else "Failed to validate"
        print "%s lbry://%s/%s - %s" % (msg, channels[claim.certificate_id], name, claim.protobuf.stream.metadata.title)
