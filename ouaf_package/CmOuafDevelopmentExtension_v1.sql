

------------------------------------------------------------------------
---- Configuration script generated at 2026-09-11 10:35:48.827756 ------
------------------------------------------------------------------------

SET DEFINE OFF;



-----------Configuration Manager Sequence Number 1

------ Statement for CI_MD_SVC, condition where SVC_NAME='CMSCRTEXTP'
DELETE FROM CI_MD_SVC where SVC_NAME='CMSCRTEXTP';

INSERT INTO CI_MD_SVC(MD_SVC_TYPE_FLG, OWNER_FLG, VERSION, SVC_NAME) VALUES ('JAVA', 'CM  ', '2', 'CMSCRTEXTP          ');
------ Statement for CI_MD_SVC_L, condition where SVC_NAME='CMSCRTEXTP'
DELETE FROM CI_MD_SVC_L where SVC_NAME='CMSCRTEXTP';

INSERT INTO CI_MD_SVC_L(OWNER_FLG, VERSION, DESCR, LANGUAGE_CD, SVC_NAME) VALUES ('CM  ', '1', 'Script as Text Viewer', 'ENG', 'CMSCRTEXTP          ');
------ Statement for CI_MD_SVC_PRG, condition where SVC_NAME='CMSCRTEXTP'
DELETE FROM CI_MD_SVC_PRG where SVC_NAME='CMSCRTEXTP';



-----------Configuration Manager Sequence Number 2

------ Statement for F1_BUS_SVC, condition where BUS_SVC_CD='CmScriptAsTextViewer'
DELETE FROM F1_BUS_SVC where BUS_SVC_CD='CmScriptAsTextViewer';

INSERT INTO F1_BUS_SVC(APP_SVC_ID, OWNER_FLG, VERSION, SVC_NAME, BUS_SVC_CD) VALUES ('F1-DFLTAPS          ', 'CM  ', '5', 'CMSCRTEXTP          ', 'CmScriptAsTextViewer          ');
------ Statement for F1_BUS_SVC_L, condition where BUS_SVC_CD='CmScriptAsTextViewer'
DELETE FROM F1_BUS_SVC_L where BUS_SVC_CD='CmScriptAsTextViewer';

INSERT INTO F1_BUS_SVC_L(OWNER_FLG, DESCRLONG, DESCR, VERSION, LANGUAGE_CD, BUS_SVC_CD) VALUES ('CM  ', ' ', 'Script as Text Viewer', '1', 'ENG', 'CmScriptAsTextViewer          ');
------ Statement for F1_SCHEMA, condition where SCHEMA_NAME = 'CmScriptAsTextViewer' AND SCHEMA_TYPE_FLG ='F1BS'
DELETE FROM F1_SCHEMA where SCHEMA_NAME = 'CmScriptAsTextViewer' AND SCHEMA_TYPE_FLG ='F1BS';

INSERT INTO F1_SCHEMA(OWNER_FLG, SCHEMA_DEFN, VERSION, SCHEMA_TYPE_FLG, SCHEMA_NAME) VALUES ('CM  ', '
<schema pageAction="change"> 
    <script mapField="SCR_CD"/>  
    <schemaName mapField="SCHEMA_NAME"/>  
    <dataAreaName mapField="DA_NAME"/>  
    <option mapField="CHAR_VAL"/>  
    <schemaDefinition mapField="SCHEMA_DEFN"/>  
    <editDataArea mapField="EDIT_DATA_TEXT"/> 
</schema>
', '4', 'F1BS', 'CmScriptAsTextViewer          ');


-----------Configuration Manager Sequence Number 3

------ Statement for CI_XAI_IN_SVC, condition where XAI_IN_SVC_ID='CM42263449'
DELETE FROM CI_XAI_IN_SVC where XAI_IN_SVC_ID='CM42263449';

INSERT INTO CI_XAI_IN_SVC(SCHEMA_TYPE_FLG, SCHEMA_NAME, POST_ERROR_SW, OWNER_FLG, XAI_IN_SVC_NAME, RECORD_XSL, VERSION, DEBUG_SW, TRACE_SW, XAI_JDBC_CON_ID, STGUP_INTRFC_NAME, STGUP_FILE_NAME, STGUP_TYPE_FLG, SEARCH_TYPE_FLG, RESPONSE_XSL, INPUT_XSL, ACTIVE_SW, TRANS_TYPE_FLG, XAI_ADAPTER_ID, RESPONSE_SCHEMA, REQUEST_SCHEMA, SVC_NAME, XAI_IN_SVC_ID) VALUES ('F1BS', 'CmScriptAsTextViewer          ', 'N', 'CM  ', 'CmScriptAsTextViewer', ' ', '2', 'N', 'N', '            ', ' ', ' ', '    ', '    ', ' ', ' ', 'Y', 'READ', 'BusinessAdaptor                 ', ' ', ' ', '                    ', 'CM42263449');
------ Statement for CI_XAI_IN_SVC_L, condition where XAI_IN_SVC_ID='CM42263449'
DELETE FROM CI_XAI_IN_SVC_L where XAI_IN_SVC_ID='CM42263449';

INSERT INTO CI_XAI_IN_SVC_L(DESCRLONG, OWNER_FLG, VERSION, DESCR, XAI_IN_SVC_ID, LANGUAGE_CD) VALUES ('Script as Text Viewer', 'CM  ', '1', 'Script as Text Viewer', 'CM42263449', 'ENG');
------ Statement for CI_XAI_SVC_PARM, condition where XAI_IN_SVC_ID='CM42263449'
DELETE FROM CI_XAI_SVC_PARM where XAI_IN_SVC_ID='CM42263449';


